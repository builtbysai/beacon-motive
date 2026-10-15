// Injected into every page while Teach Mode is recording. It reports high-level DOM events (click, committed
// field value, selection, Enter) with candidate semantic targets. It never reports raw keystrokes, and the value of a
// sensitive field (password, one-time code, card number, ...) never leaves the page.
(() => {
  if (window.__motiveInstalled) return;
  window.__motiveInstalled = true;
  const SENSITIVE = /pass|pwd|secret|token|otp|cvv|cvc|card|ssn|pin\b/i;
  let seq = 0;
  const lastSent = new WeakMap();

  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  function role(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "img";
    if (tag === "input") {
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["text", "email", "search", "tel", "url", "password", "number", ""].includes(type)) return type === "number" ? "spinbutton" : "textbox";
    }
    return null;
  }

  function labelText(el) {
    if (el.labels && el.labels.length) return norm([...el.labels].map((l) => l.textContent).join(" "));
    const id = el.getAttribute("aria-labelledby");
    if (id) return norm(id.split(" ").map((i) => (document.getElementById(i) || {}).textContent).join(" "));
    return "";
  }

  function accName(el) {
    return (
      norm(el.getAttribute("aria-label")) ||
      labelText(el) ||
      (el.tagName === "INPUT" && ["button", "submit", "reset"].includes((el.type || "").toLowerCase()) ? norm(el.value) : "") ||
      norm(el.getAttribute("alt")) ||
      norm(el.getAttribute("placeholder")) ||
      norm(el.getAttribute("title")) ||
      norm(el.textContent).slice(0, 80)
    );
  }

  function cssPath(el) {
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [n];
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(n) + 1) + ")" : ""));
    }
    return parts.join(" > ");
  }

  function candidates(el) {
    const out = [];
    const testId = el.getAttribute("data-testid");
    const r = role(el);
    const name = accName(el);
    if (testId) out.push({ testId });
    if (r && name) out.push({ role: r, name });
    const lt = labelText(el);
    if (lt) out.push({ label: lt });
    const own = norm(el.textContent);
    if (own && own.length <= 80 && !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) out.push({ text: own });
    out.push({ css: cssPath(el) });
    return out;
  }

  function sensitive(el) {
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/password|one-time-code|cc-/.test(ac)) return true;
    return SENSITIVE.test(el.name || "") || SENSITIVE.test(el.id || "");
  }

  function emit(kind, el, extra) {
    const id = ++seq;
    el.setAttribute("data-motive-" + id, "1");
    window.__motiveEvent({ seq: id, kind, candidates: candidates(el), label: labelText(el) || accName(el), ...extra });
  }

  function flush(el) {
    if (!el || !["INPUT", "TEXTAREA"].includes(el.tagName)) return;
    const type = (el.type || "").toLowerCase();
    if (["checkbox", "radio", "button", "submit", "reset", "file", "hidden"].includes(type)) return;
    if (lastSent.get(el) === el.value) return;
    lastSent.set(el, el.value);
    const secret = sensitive(el);
    emit("fill", el, { secret, ...(secret ? {} : { value: el.value }) });
  }

  document.addEventListener(
    "change",
    (ev) => {
      const el = ev.target;
      if (!(el instanceof Element)) return;
      if (el.tagName === "SELECT") emit("select", el, { value: el.options[el.selectedIndex] ? norm(el.options[el.selectedIndex].text) : "" });
      else flush(el);
    },
    true,
  );

  document.addEventListener(
    "click",
    (ev) => {
      if (!(ev.target instanceof Element) || !ev.isTrusted) return;
      const el = ev.target.closest("a,button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],label") || ev.target;
      const tag = el.tagName;
      if (tag === "SELECT" || tag === "TEXTAREA") return;
      if (tag === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "image"].includes((el.type || "").toLowerCase())) return;
      if (tag === "LABEL" && el.control) return; // the control's own click follows
      flush(document.activeElement);
      emit("click", el, {});
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (ev) => {
      if (!ev.isTrusted || ev.key !== "Enter") return;
      const el = ev.target;
      if (!(el instanceof Element) || el.tagName !== "INPUT") return;
      flush(el);
      emit("press", el, { key: "Enter" });
    },
    true,
  );

  // A visible, unmissable indicator that recording is on.
  function banner() {
    if (document.getElementById("__motive_banner")) return;
    const host = document.createElement("div");
    host.id = "__motive_banner";
    host.style.cssText = "position:fixed;z-index:2147483647;right:12px;bottom:12px;pointer-events:none";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<div style="font:600 12px system-ui;background:#b00020;color:#fff;padding:6px 10px;border-radius:4px">● Recording (Motive) — passwords are not captured</div>';
    (document.body || document.documentElement).appendChild(host);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", banner);
  else banner();
})();
