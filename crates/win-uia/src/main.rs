//! Windows UI Automation sidecar. One JSON request per line on stdin, one JSON response per line on stdout.
//! It never elevates, never injects raw input, and only does what the request names. Everything is semantic:
//! windows are found by name/class/process, controls by automation id / name / control type.
mod ocr;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use uiautomation::patterns::{UIExpandCollapsePattern, UIInvokePattern, UISelectionItemPattern, UITogglePattern, UIValuePattern, UIWindowPattern};
use std::sync::Mutex;
use uiautomation::events::{CustomEventHandlerFn, CustomPropertyChangedEventHandlerFn, UIEventHandler, UIPropertyChangedEventHandler};
use uiautomation::types::{TreeScope, UIProperty};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

/// Replies and recorded events both go to stdout, from different threads, one JSON object per line.
static OUT: Mutex<()> = Mutex::new(());
fn emit(v: &Value) {
    let _guard = OUT.lock().unwrap();
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

#[derive(Deserialize)]
struct Request {
    id: u64,
    method: String,
    #[serde(default)]
    params: Value,
}

struct Failure {
    code: &'static str,
    message: String,
}
type Res = Result<Value, Failure>;

fn fail<T>(code: &'static str, message: impl Into<String>) -> Result<T, Failure> {
    Err(Failure { code, message: message.into() })
}
fn uia<T>(r: uiautomation::Result<T>) -> Result<T, Failure> {
    r.map_err(|e| Failure { code: "uia_error", message: e.to_string() })
}

#[derive(Deserialize, Default)]
struct WindowSel {
    name: Option<String>,
    #[serde(rename = "nameContains")]
    name_contains: Option<String>,
    #[serde(rename = "className")]
    class_name: Option<String>,
    #[serde(rename = "processId")]
    process_id: Option<u32>,
}
#[derive(Deserialize, Default)]
struct TargetSel {
    #[serde(rename = "automationId")]
    automation_id: Option<String>,
    name: Option<String>,
    #[serde(rename = "nameContains")]
    name_contains: Option<String>,
    #[serde(rename = "controlType")]
    control_type: Option<String>,
}

fn describe(e: &UIElement) -> Value {
    let r = e.get_bounding_rectangle().ok();
    json!({
        "name": e.get_name().unwrap_or_default(),
        "automationId": e.get_automation_id().unwrap_or_default(),
        "className": e.get_classname().unwrap_or_default(),
        "controlType": e.get_control_type().map(|c| format!("{c:?}")).unwrap_or_default(),
        "processId": e.get_process_id().unwrap_or(0),
        "enabled": e.is_enabled().unwrap_or(false),
        "offscreen": e.is_offscreen().unwrap_or(false),
        "password": e.is_password().unwrap_or(false),
        "rect": r.map(|r| json!({"left": r.get_left(), "top": r.get_top(), "width": r.get_width(), "height": r.get_height()})),
    })
}

fn window_matches(e: &UIElement, s: &WindowSel) -> bool {
    let name = e.get_name().unwrap_or_default();
    if let Some(n) = &s.name {
        if &name != n {
            return false;
        }
    }
    if let Some(n) = &s.name_contains {
        if !name.to_lowercase().contains(&n.to_lowercase()) {
            return false;
        }
    }
    if let Some(c) = &s.class_name {
        if &e.get_classname().unwrap_or_default() != c {
            return false;
        }
    }
    if let Some(p) = s.process_id {
        if e.get_process_id().unwrap_or(0) != p {
            return false;
        }
    }
    true
}

fn top_level(a: &UIAutomation, w: &UITreeWalker) -> Result<Vec<UIElement>, Failure> {
    let root = uia(a.get_root_element())?;
    let mut out = Vec::new();
    let mut next = w.get_first_child(&root).ok();
    while let Some(e) = next {
        next = w.get_next_sibling(&e).ok();
        out.push(e);
    }
    Ok(out)
}

fn find_window(a: &UIAutomation, w: &UITreeWalker, v: &Value) -> Result<UIElement, Failure> {
    let sel: WindowSel = serde_json::from_value(v.clone()).unwrap_or_default();
    let all = top_level(a, w)?;
    let hits: Vec<UIElement> = all.into_iter().filter(|e| window_matches(e, &sel)).collect();
    match hits.len() {
        0 => fail("not_found", "no window matches the selector"),
        1 => Ok(hits.into_iter().next().unwrap()),
        n => fail("ambiguous", format!("{n} windows match the selector; make it more specific")),
    }
}

fn target_matches(e: &UIElement, s: &TargetSel) -> bool {
    if let Some(id) = &s.automation_id {
        if &e.get_automation_id().unwrap_or_default() != id {
            return false;
        }
    }
    let name = e.get_name().unwrap_or_default();
    if let Some(n) = &s.name {
        if &name != n {
            return false;
        }
    }
    if let Some(n) = &s.name_contains {
        if !name.to_lowercase().contains(&n.to_lowercase()) {
            return false;
        }
    }
    if let Some(t) = &s.control_type {
        let actual = e.get_control_type().map(|c| format!("{c:?}")).unwrap_or_default();
        if !actual.eq_ignore_ascii_case(t) {
            return false;
        }
    }
    true
}

/// Depth-first search under `root`, collecting at most `limit` matches.
fn search(w: &UITreeWalker, root: &UIElement, s: &TargetSel, depth: u32, limit: usize, out: &mut Vec<UIElement>) {
    if out.len() >= limit || depth == 0 {
        return;
    }
    let mut next = w.get_first_child(root).ok();
    while let Some(e) = next {
        next = w.get_next_sibling(&e).ok();
        if target_matches(&e, s) {
            out.push(e.clone());
            if out.len() >= limit {
                return;
            }
        }
        search(w, &e, s, depth - 1, limit, out);
    }
}

fn find_target(w: &UITreeWalker, win: &UIElement, v: &Value) -> Result<UIElement, Failure> {
    let sel: TargetSel = serde_json::from_value(v.clone()).unwrap_or_default();
    if sel.automation_id.is_none() && sel.name.is_none() && sel.name_contains.is_none() && sel.control_type.is_none() {
        return fail("bad_request", "target needs at least one of automationId, name, nameContains, controlType");
    }
    let mut hits = Vec::new();
    search(w, win, &sel, 40, 2, &mut hits);
    match hits.len() {
        0 => fail("not_found", "no control matches the selector"),
        1 => Ok(hits.remove(0)),
        _ => fail("ambiguous", "more than one control matches the selector; add automationId or controlType"),
    }
}

fn tree(w: &UITreeWalker, e: &UIElement, depth: u32, budget: &mut u32) -> Value {
    let mut d = describe(e);
    if depth > 0 && *budget > 0 {
        let mut kids = Vec::new();
        let mut next = w.get_first_child(e).ok();
        while let Some(c) = next {
            next = w.get_next_sibling(&c).ok();
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            kids.push(tree(w, &c, depth - 1, budget));
        }
        d["children"] = Value::Array(kids);
    }
    d
}

fn read_text(e: &UIElement) -> String {
    if let Ok(p) = e.get_pattern::<UIValuePattern>() {
        if let Ok(v) = p.get_value() {
            if !v.is_empty() {
                return v;
            }
        }
    }
    e.get_name().unwrap_or_default()
}

/// Elements resolved earlier, keyed by the selector text. A cached element is reused only while it still answers;
/// otherwise it is dropped and the selector is resolved again, so a closed or re-created control is never acted on.
#[derive(Default)]
struct Cache {
    windows: HashMap<String, UIElement>,
    targets: HashMap<String, UIElement>,
    recording: Option<(UIElement, UIEventHandler, UIEventHandler, UIPropertyChangedEventHandler)>,
}

fn alive(e: &UIElement) -> bool {
    e.get_process_id().is_ok() && e.get_bounding_rectangle().is_ok()
}

fn cached_window(a: &UIAutomation, w: &UITreeWalker, c: &mut Cache, v: &Value) -> Result<UIElement, Failure> {
    let key = v.to_string();
    if let Some(e) = c.windows.get(&key) {
        if alive(e) {
            return Ok(e.clone());
        }
        c.windows.remove(&key);
        c.targets.retain(|k, _| !k.starts_with(&key));
    }
    let e = find_window(a, w, v)?;
    c.windows.insert(key, e.clone());
    Ok(e)
}

fn cached_target(w: &UITreeWalker, c: &mut Cache, win: &UIElement, wsel: &Value, tsel: &Value) -> Result<UIElement, Failure> {
    let key = format!("{}|{}", wsel, tsel);
    if let Some(e) = c.targets.get(&key) {
        if alive(e) {
            return Ok(e.clone());
        }
        c.targets.remove(&key);
    }
    let e = find_target(w, win, tsel)?;
    c.targets.insert(key, e.clone());
    Ok(e)
}

fn handle(a: &UIAutomation, w: &UITreeWalker, c: &mut Cache, req: &Request) -> Res {
    let p = &req.params;
    match req.method.as_str() {
        "ping" => Ok(json!({"pong": true})),
        "windows.list" => {
            let wins = top_level(a, w)?;
            Ok(Value::Array(
                wins.iter()
                    .filter(|e| !e.get_name().unwrap_or_default().is_empty())
                    .map(describe)
                    .collect(),
            ))
        }
        "window.find" => {
            let e = cached_window(a, w, c, &p["window"])?;
            let mut d = describe(&e);
            d["process"] = json!(ocr::process_name(e.get_process_id().unwrap_or(0) as u32));
            Ok(d)
        }
        "ocr" => {
            let win = cached_window(a, w, c, &p["window"])?;
            ocr::run(&win, &p["rect"]).or_else(|m| fail("adapter_failed", m))
        }
        "window.close" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let pattern = uia(win.get_pattern::<UIWindowPattern>())?;
            uia(pattern.close())?;
            c.windows.clear();
            c.targets.clear();
            Ok(json!({"closed": true}))
        }
        "tree" => {
            let win = find_window(a, w, &p["window"])?;
            let depth = p["depth"].as_u64().unwrap_or(4).min(12) as u32;
            let mut budget = p["maxNodes"].as_u64().unwrap_or(500).min(5000) as u32;
            Ok(tree(w, &win, depth, &mut budget))
        }
        "record.start" => {
            if c.recording.is_some() {
                return fail("precondition_failed", "already recording");
            }
            let win = find_window(a, w, &p["window"])?;
            // What the user did, described by the control and never by its secret contents.
            let report = move |kind: &'static str, sender: &UIElement, extra: Value| {
                let password = sender.is_password().unwrap_or(false);
                let mut ev = json!({"event": "record", "kind": kind, "element": describe(sender), "password": password});
                if !password {
                    if let Value::Object(m) = extra {
                        for (k, v) in m {
                            ev[k] = v;
                        }
                    }
                }
                emit(&ev);
            };
            let r1 = report.clone();
            let invoke_fn: Box<CustomEventHandlerFn> = Box::new(move |sender, _t| {
                r1("invoke", sender, json!({}));
                Ok(())
            });
            let invoke_handler = UIEventHandler::from(invoke_fn);
            let r2 = report.clone();
            let select_fn: Box<CustomEventHandlerFn> = Box::new(move |sender, _t| {
                r2("select", sender, json!({"text": sender.get_name().unwrap_or_default()}));
                Ok(())
            });
            let select_handler = UIEventHandler::from(select_fn);
            let r3 = report.clone();
            let prop_fn: Box<CustomPropertyChangedEventHandlerFn> = Box::new(move |sender, prop, _v| {
                if prop == UIProperty::ValueValue {
                    let text = sender.get_pattern::<UIValuePattern>().ok().and_then(|v| v.get_value().ok()).unwrap_or_default();
                    r3("value", sender, json!({"text": text}));
                } else {
                    let st = sender.get_pattern::<UITogglePattern>().ok().and_then(|t| t.get_toggle_state().ok()).map(|st| format!("{st:?}").to_lowercase());
                    r3("toggle", sender, json!({"toggle": st}));
                }
                Ok(())
            });
            let prop_handler = UIPropertyChangedEventHandler::from(prop_fn);
            uia(a.add_automation_event_handler(uiautomation::events::UIEventType::Invoke_Invoked, &win, TreeScope::Subtree, None, &invoke_handler))?;
            uia(a.add_automation_event_handler(uiautomation::events::UIEventType::SelectionItem_ElementSelected, &win, TreeScope::Subtree, None, &select_handler))?;
            uia(a.add_property_changed_event_handler(&win, TreeScope::Subtree, None, &prop_handler, &[UIProperty::ValueValue, UIProperty::ToggleToggleState]))?;
            c.recording = Some((win, invoke_handler, select_handler, prop_handler));
            Ok(json!({"recording": true}))
        }
        "record.stop" => {
            if let Some((win, h1, h2, h3)) = c.recording.take() {
                let _ = a.remove_automation_event_handler(uiautomation::events::UIEventType::Invoke_Invoked, &win, &h1);
                let _ = a.remove_automation_event_handler(uiautomation::events::UIEventType::SelectionItem_ElementSelected, &win, &h2);
                let _ = a.remove_property_changed_event_handler(&win, &h3);
            }
            Ok(json!({"recording": false}))
        }
        "element.find" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            let mut d = describe(&el);
            d["text"] = Value::String(read_text(&el));
            Ok(d)
        }
        "element.read" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            if el.is_password().unwrap_or(false) {
                return fail("denied", "password fields are never read");
            }
            let toggle = el.get_pattern::<UITogglePattern>().ok().and_then(|t| t.get_toggle_state().ok()).map(|st| format!("{st:?}").to_lowercase());
            let selected = el.get_pattern::<UISelectionItemPattern>().ok().and_then(|t| t.is_selected().ok());
            Ok(json!({"text": read_text(&el), "name": el.get_name().unwrap_or_default(), "enabled": el.is_enabled().unwrap_or(false), "toggle": toggle, "selected": selected}))
        }
        "element.invoke" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            if !el.is_enabled().unwrap_or(false) {
                return fail("not_actionable", "control is disabled");
            }
            // Activate the way the control itself offers: press, toggle, choose, or open.
            if let Ok(pattern) = el.get_pattern::<UIInvokePattern>() {
                uia(pattern.invoke())?;
                return Ok(json!({"invoked": true, "how": "invoke"}));
            }
            if let Ok(pattern) = el.get_pattern::<UITogglePattern>() {
                uia(pattern.toggle())?;
                return Ok(json!({"invoked": true, "how": "toggle"}));
            }
            if let Ok(pattern) = el.get_pattern::<UISelectionItemPattern>() {
                uia(pattern.select())?;
                return Ok(json!({"invoked": true, "how": "select"}));
            }
            if let Ok(pattern) = el.get_pattern::<UIExpandCollapsePattern>() {
                uia(pattern.expand())?;
                return Ok(json!({"invoked": true, "how": "expand"}));
            }
            fail("unsupported", "control cannot be pressed, toggled, selected or expanded")
        }
        "element.select" => {
            // Opens the container (a combo box) when given, then chooses the named item.
            let win = cached_window(a, w, c, &p["window"])?;
            if !p["container"].is_null() {
                let container = find_target(w, &win, &p["container"])?;
                if let Ok(pattern) = container.get_pattern::<UIExpandCollapsePattern>() {
                    uia(pattern.expand())?;
                }
            }
            let el = find_target(w, &win, &p["target"])?;
            let pattern = match el.get_pattern::<UISelectionItemPattern>() {
                Ok(p) => p,
                Err(_) => return fail("unsupported", "item cannot be selected"),
            };
            uia(pattern.select())?;
            if !p["container"].is_null() {
                if let Ok(container) = find_target(w, &win, &p["container"]) {
                    if let Ok(pattern) = container.get_pattern::<UIExpandCollapsePattern>() {
                        let _ = pattern.collapse();
                    }
                }
            }
            Ok(json!({"selected": true}))
        }
        "element.keys" => {
            // Navigation keys only (Enter, Tab, Escape, Space, arrows, Backspace, Delete, Home, End), sent to the focused control.
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            if !el.is_enabled().unwrap_or(false) {
                return fail("not_actionable", "control is disabled");
            }
            let keys = p["keys"].as_str().unwrap_or_default();
            let allowed = ["enter", "tab", "esc", "space", "up", "down", "left", "right", "backspace", "delete", "home", "end"];
            let mut rest = keys;
            if rest.is_empty() {
                return fail("bad_request", "keys is empty");
            }
            while !rest.is_empty() {
                let Some(end) = rest.find('}') else { return fail("bad_request", "keys must be {name} tokens") };
                if !rest.starts_with('{') || !allowed.contains(&rest[1..end].to_lowercase().as_str()) {
                    return fail("denied", "only navigation keys are allowed: enter tab esc space up down left right backspace delete home end");
                }
                rest = &rest[end + 1..];
            }
            uia(el.send_keys(keys, 20))?;
            Ok(json!({"sent": true}))
        }
        "element.type" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            if !el.is_enabled().unwrap_or(false) {
                return fail("not_actionable", "control is disabled");
            }
            let text = p["text"].as_str().unwrap_or_default();
            uia(el.set_focus())?;
            uia(el.send_text(text, 8))?;
            Ok(json!({"typed": text.chars().count()}))
        }
        "element.setValue" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            if !el.is_enabled().unwrap_or(false) {
                return fail("not_actionable", "control is disabled");
            }
            let value = p["value"].as_str().unwrap_or_default();
            let pattern = match el.get_pattern::<UIValuePattern>() {
                Ok(p) => p,
                Err(_) => return fail("unsupported", "control does not support Value"),
            };
            uia(pattern.set_value(value))?;
            Ok(json!({"set": true}))
        }
        other => fail("unknown_method", format!("unknown method {other}")),
    }
}

fn main() {
    let automation = match UIAutomation::new() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("UI Automation unavailable: {e}");
            std::process::exit(3);
        }
    };
    let walker = automation.get_control_view_walker().expect("control view walker");
    let stdin = std::io::stdin();
    let mut cache = Cache::default();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => match handle(&automation, &walker, &mut cache, &req) {
                Ok(result) => json!({"id": req.id, "ok": true, "result": result}),
                Err(f) => json!({"id": req.id, "ok": false, "error": {"code": f.code, "message": f.message}}),
            },
            Err(e) => json!({"id": 0, "ok": false, "error": {"code": "bad_request", "message": e.to_string()}}),
        };
        emit(&reply);
    }
}
