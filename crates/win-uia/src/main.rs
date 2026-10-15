//! Windows UI Automation sidecar. One JSON request per line on stdin, one JSON response per line on stdout.
//! It never elevates, never injects raw input, and only does what the request names. Everything is semantic:
//! windows are found by name/class/process, controls by automation id / name / control type.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use uiautomation::patterns::{UIInvokePattern, UIValuePattern, UIWindowPattern};
use uiautomation::{UIAutomation, UIElement, UITreeWalker};

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
        "window.find" => Ok(describe(&cached_window(a, w, c, &p["window"])?)),
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
            Ok(json!({"text": read_text(&el), "name": el.get_name().unwrap_or_default(), "enabled": el.is_enabled().unwrap_or(false)}))
        }
        "element.invoke" => {
            let win = cached_window(a, w, c, &p["window"])?;
            let el = cached_target(w, c, &win, &p["window"], &p["target"])?;
            if !el.is_enabled().unwrap_or(false) {
                return fail("not_actionable", "control is disabled");
            }
            let pattern = match el.get_pattern::<UIInvokePattern>() {
                Ok(p) => p,
                Err(_) => return fail("unsupported", "control does not support Invoke"),
            };
            uia(pattern.invoke())?;
            Ok(json!({"invoked": true}))
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
    let mut out = std::io::stdout().lock();
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
        let _ = writeln!(out, "{reply}");
        let _ = out.flush();
    }
}
