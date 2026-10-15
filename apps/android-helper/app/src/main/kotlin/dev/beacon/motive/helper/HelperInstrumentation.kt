package dev.beacon.motive.helper

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.Instrumentation
import android.app.UiAutomation
import android.graphics.Rect
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.os.Bundle
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.security.MessageDigest

/**
 * Resident helper for Beacon Motive. Started by `adb shell am instrument`, it serves a line-based JSON protocol on
 * an abstract local socket of the phone (reached from the computer through `adb forward`; no network permission). It ends when the instrument command ends.
 *
 * Privacy boundary: every request names the packages the workflow may use. Nodes of any other package are never
 * serialised, and a tap, swipe or key press is refused unless the window it would land on belongs to a named package.
 * Password fields are returned without their text. Requests must carry the one-time token passed at start.
 */
class HelperInstrumentation : Instrumentation() {
    private var token = ""
    private var socketName = ""
    private var server: LocalServerSocket? = null

    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        token = arguments?.getString("token").orEmpty()
        socketName = arguments?.getString("socket").orEmpty()
        start()
    }

    override fun onStart() {
        super.onStart()
        if (token.length < 16 || !Regex("[a-z0-9-]{8,64}").matches(socketName)) {
            finish(Activity.RESULT_CANCELED, Bundle().apply { putString("error", "token (16+ chars) and socket name are required") })
            return
        }
        val ua = getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        ua.serviceInfo = ua.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        }
        val ss = LocalServerSocket(socketName)
        server = ss
        val bundle = Bundle().apply { putString("status", "ready") }
        sendStatus(0, bundle)
        var quit = false
        while (!quit) {
            val client = try { ss.accept() } catch (e: Exception) { break }
            quit = serve(client, Controller(ua))
        }
        ss.close()
        finish(Activity.RESULT_OK, Bundle())
    }

    override fun onDestroy() {
        server?.close()
        super.onDestroy()
    }

    /** Returns true when the client asked the helper to stop. */
    private fun serve(client: LocalSocket, ctl: Controller): Boolean {
        client.use { sock ->
            val reader = BufferedReader(InputStreamReader(sock.inputStream, Charsets.UTF_8))
            val out = sock.outputStream
            while (true) {
                val line = reader.readLine() ?: return false
                val reply = JSONObject()
                try {
                    val req = JSONObject(line)
                    reply.put("id", req.opt("id"))
                    if (!sameToken(req.optString("token"))) throw Refused("bad token")
                    when (req.optString("cmd")) {
                        "ping" -> reply.put("ok", true)
                        "quit" -> {
                            out.write("{\"ok\":true}\n".toByteArray())
                            return true
                        }
                        else -> ctl.handle(req, reply)
                    }
                } catch (e: Refused) {
                    reply.put("ok", false).put("error", e.message).put("code", "scope_denied")
                } catch (e: Exception) {
                    reply.put("ok", false).put("error", e.javaClass.simpleName + ": " + e.message).put("code", "adapter_failed")
                }
                out.write((reply.toString() + "\n").toByteArray(Charsets.UTF_8))
                out.flush()
            }
        }
    }

    private fun sameToken(given: String) = MessageDigest.isEqual(given.toByteArray(), token.toByteArray())
}

class Refused(message: String) : Exception(message)

private const val MAX_NODES = 5000

class Controller(private val ua: UiAutomation) {
    fun handle(req: JSONObject, reply: JSONObject) {
        val packages = req.optJSONArray("packages")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }.orEmpty()
        if (packages.isEmpty()) throw Refused("no package is allowed")
        when (req.optString("cmd")) {
            "tree" -> reply.put("ok", true).put("nodes", tree(packages))
            "tap" -> {
                val x = req.getDouble("x").toFloat()
                val y = req.getDouble("y").toFloat()
                requireWindow(packages, x, y)
                gesture(x, y, x, y, 40)
                reply.put("ok", true)
            }
            "swipe" -> {
                val x1 = req.getDouble("x1").toFloat()
                val y1 = req.getDouble("y1").toFloat()
                requireWindow(packages, x1, y1)
                gesture(x1, y1, req.getDouble("x2").toFloat(), req.getDouble("y2").toFloat(), req.optLong("ms", 300).coerceIn(50, 2000))
                reply.put("ok", true)
            }
            "setText" -> {
                val x = req.getDouble("x").toFloat()
                val y = req.getDouble("y").toFloat()
                setText(packages, x, y, req.getString("text"))
                reply.put("ok", true)
            }
            "key" -> {
                // Home only leaves the current app, so it is allowed from anywhere; back could dismiss another
                // app's dialog, so it needs an allowed package in front.
                val active = ua.rootInActiveWindow?.packageName?.toString().orEmpty()
                if (req.getString("key") != "home" && active !in packages) throw Refused("the focused window is not an allowed package")
                key(req.getString("key"))
                reply.put("ok", true)
            }
            else -> throw IllegalArgumentException("unknown command")
        }
    }

    private fun windows(): List<AccessibilityWindowInfo> = ua.windows.sortedByDescending { it.layer }

    private fun requireWindow(packages: Set<String>, x: Float, y: Float) {
        val rect = Rect()
        for (w in windows()) {
            w.getBoundsInScreen(rect)
            if (rect.contains(x.toInt(), y.toInt())) {
                val pkg = w.root?.packageName?.toString().orEmpty()
                if (pkg !in packages) throw Refused("the window at that point is not an allowed package")
                return
            }
        }
        throw Refused("no window at that point")
    }

    private fun tree(packages: Set<String>): JSONArray {
        // Let transitions and animations settle so bounds are where the controls will stay; a screen that never
        // goes idle (a video, a spinner) just gets read after the cap.
        try {
            ua.waitForIdle(150, 1500)
        } catch (e: java.util.concurrent.TimeoutException) {
            // read it as it is
        }
        val out = JSONArray()
        for (w in windows()) {
            val root = w.root ?: continue
            if (root.packageName?.toString() !in packages) continue
            walk(root, out)
        }
        return out
    }

    private fun walk(n: AccessibilityNodeInfo, out: JSONArray) {
        if (out.length() >= MAX_NODES) return
        val b = Rect()
        n.getBoundsInScreen(b)
        if (n.isVisibleToUser) {
            out.put(
                JSONObject()
                    .put("text", if (n.isPassword) "" else n.text?.toString().orEmpty())
                    .put("resourceId", n.viewIdResourceName.orEmpty())
                    .put("className", n.className?.toString().orEmpty())
                    .put("package", n.packageName?.toString().orEmpty())
                    .put("contentDesc", n.contentDescription?.toString().orEmpty())
                    .put("clickable", n.isClickable)
                    .put("enabled", n.isEnabled)
                    .put("password", n.isPassword)
                    .put("checked", n.isChecked)
                    .put("editable", n.isEditable)
                    .put("bounds", JSONArray(listOf(b.left, b.top, b.right, b.bottom))),
            )
        }
        for (i in 0 until n.childCount) n.getChild(i)?.let { walk(it, out) }
    }

    /** Sets text with the accessibility action, so any Unicode works. The target is the editable node under the point. */
    private fun setText(packages: Set<String>, x: Float, y: Float, text: String) {
        requireWindow(packages, x, y)
        val target = findEditable(packages, x.toInt(), y.toInt()) ?: throw IllegalStateException("no editable field at that point")
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
        if (!target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) throw IllegalStateException("the field refused the text")
    }

    private fun findEditable(packages: Set<String>, x: Int, y: Int): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        var bestArea = Long.MAX_VALUE
        fun visit(n: AccessibilityNodeInfo) {
            val b = Rect()
            n.getBoundsInScreen(b)
            if (n.isEditable && !n.isPassword && b.contains(x, y)) {
                val area = b.width().toLong() * b.height()
                if (area < bestArea) {
                    best = n
                    bestArea = area
                }
            }
            for (i in 0 until n.childCount) n.getChild(i)?.let { visit(it) }
        }
        for (w in windows()) {
            val root = w.root ?: continue
            if (root.packageName?.toString() in packages) visit(root)
        }
        return best
    }

    private fun gesture(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        val start = SystemClock.uptimeMillis()
        fun send(action: Int, x: Float, y: Float, at: Long) {
            val ev = MotionEvent.obtain(start, at, action, x, y, 0)
            ev.source = InputDevice.SOURCE_TOUCHSCREEN
            ua.injectInputEvent(ev, true)
            ev.recycle()
        }
        send(MotionEvent.ACTION_DOWN, x1, y1, start)
        val steps = if (x1 == x2 && y1 == y2) 0 else 12
        for (i in 1..steps) {
            val f = i / steps.toFloat()
            SystemClock.sleep(durationMs / steps)
            send(MotionEvent.ACTION_MOVE, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, SystemClock.uptimeMillis())
        }
        if (steps == 0) SystemClock.sleep(durationMs)
        send(MotionEvent.ACTION_UP, x2, y2, SystemClock.uptimeMillis())
    }

    private fun key(name: String) {
        when (name) {
            "back" -> ua.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            "home" -> ua.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME)
            "enter" -> keyEvent(KeyEvent.KEYCODE_ENTER)
            "tab" -> keyEvent(KeyEvent.KEYCODE_TAB)
            else -> throw IllegalArgumentException("unknown key")
        }
    }

    private fun keyEvent(code: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val ev = KeyEvent(now, now, action, code, 0)
            ev.source = InputDevice.SOURCE_KEYBOARD
            ua.injectInputEvent(ev, true)
        }
    }
}
