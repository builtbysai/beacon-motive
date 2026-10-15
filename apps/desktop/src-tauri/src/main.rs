// Desktop shell for Beacon Motive. The web view never sees the API token and never makes network requests:
// it calls the commands below, and this process talks to the loopback API (ADR 0003, ADR 0008).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, State};

const DEFAULT_PORT: u16 = 47615;

#[derive(Default)]
struct Engine(Mutex<Option<Child>>);

fn port() -> u16 {
    std::env::var("MOTIVE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT)
}

fn data_dir() -> PathBuf {
    if let Ok(h) = std::env::var("MOTIVE_HOME") {
        return PathBuf::from(h);
    }
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".local").join("share"));
    base.join("beacon-motive")
}

fn token() -> Option<String> {
    std::fs::read_to_string(data_dir().join("api-token")).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

fn repo_root() -> PathBuf {
    if let Ok(r) = std::env::var("MOTIVE_REPO") {
        return PathBuf::from(r);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("..")
}

fn call(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if !path.starts_with("/v1/") || path.contains("..") || path.contains('@') {
        return Err("path must be a /v1/ API route".into());
    }
    let token = token().ok_or("no API token yet: start the engine once")?;
    let url = format!("http://127.0.0.1:{}{}", port(), path);
    let req = ureq::request(method, &url)
        .timeout(Duration::from_secs(10))
        .set("Authorization", &format!("Bearer {token}"));
    let resp = match body {
        Some(b) => req.send_json(b),
        None => req.call(),
    };
    match resp {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(_, r)) => {
            let v: Value = r.into_json().unwrap_or(Value::Null);
            Err(v["error"]["message"].as_str().unwrap_or("request refused").to_string())
        }
        Err(e) => Err(format!("engine not reachable: {e}")),
    }
}

#[derive(Serialize)]
struct Status {
    running: bool,
    port: u16,
    #[serde(rename = "startedHere")]
    started_here: bool,
}

// Commands are async so they run on a worker thread, not the UI thread: the Inspector asks Windows to describe every
// window, including this one, and a blocked UI thread would stall that for ten seconds.
#[tauri::command]
async fn engine_status(engine: State<'_, Engine>) -> Result<Status, String> {
    let running = call("GET", "/v1/capabilities", None).is_ok();
    let started_here = engine.0.lock().map(|g| g.is_some()).unwrap_or(false);
    Ok(Status { running, port: port(), started_here })
}

/// Starts `motive serve` with fixed arguments. Nothing from the UI is passed to the process.
#[tauri::command]
async fn start_engine(engine: State<'_, Engine>) -> Result<(), String> {
    let mut guard = engine.0.lock().map_err(|_| "engine lock poisoned")?;
    if guard.is_some() {
        return Ok(());
    }
    let mut cmd = Command::new("node");
    cmd.current_dir(repo_root())
        .args(["--disable-warning=ExperimentalWarning", "src/cli.ts", "serve", "--port", &port().to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    *guard = Some(cmd.spawn().map_err(|e| format!("could not start node: {e}"))?);
    Ok(())
}

#[tauri::command]
async fn api(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    if !["GET", "PUT", "POST", "DELETE"].contains(&method.as_str()) {
        return Err("method not allowed".into());
    }
    call(&method, &path, body)
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Engine::default())
        .invoke_handler(tauri::generate_handler![engine_status, start_engine, api])
        .build(tauri::generate_context!())
        .expect("failed to build the app");
    app.run(|handle, event| {
        // Stop only an engine this app started; one the user started themselves is left alone.
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Engine>().0.lock().ok().and_then(|mut g| g.take()) {
                let _ = call("POST", "/v1/stop", None);
                let _ = child.kill();
            }
        }
    });
}
