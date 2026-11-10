pub mod bridge;
mod protocol;

use bridge::{Options, Shared, Snapshot};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Job {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct AppState {
    snapshot: Shared,
    job: Mutex<Option<Job>>,
}

#[tauri::command]
fn get_initial(state: State<'_, AppState>) -> Result<Value, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or("Cannot find home directory")?;
    let history = PathBuf::from(home)
        .join("AppData")
        .join("LocalLow")
        .join("Foresight Sports")
        .join("Foresight Premier")
        .join("ShotReplay")
        .join("history.json");
    let snapshot = state.snapshot.lock().map_err(|e| e.to_string())?.clone();
    Ok(
        json!({"defaults":{"log":"C:\\GSProV1\\Core\\GSPC\\ConnectDebug.txt","history":history.to_string_lossy()},"snapshot":snapshot}),
    )
}

#[tauri::command]
fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    Ok(state.snapshot.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
fn resize_window(window: tauri::WebviewWindow, height: f64) -> Result<(), String> {
    if !height.is_finite() || height <= 0.0 {
        return Err("Invalid window height".into());
    }
    if window.is_maximized().map_err(|e| e.to_string())?
        || window.is_fullscreen().map_err(|e| e.to_string())?
        || window.is_minimized().map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Err("Cannot determine the current display".into());
    };
    let available = monitor.work_area();
    let frame = outer.height.saturating_sub(inner.height);
    let desired = (height * window.scale_factor().map_err(|e| e.to_string())?).ceil() as u32;
    let target = desired
        .min(available.size.height.saturating_sub(frame))
        .max(1);
    if target != inner.height {
        window
            .set_size(tauri::PhysicalSize::new(inner.width, target))
            .map_err(|e| e.to_string())?;
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let outer = window.outer_size().map_err(|e| e.to_string())?;
        let max_y = i64::from(available.position.y) + i64::from(available.size.height)
            - i64::from(outer.height);
        let y = i64::from(position.y)
            .min(max_y)
            .max(i64::from(available.position.y)) as i32;
        if y != position.y {
            window
                .set_position(tauri::PhysicalPosition::new(position.x, y))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn start(state: State<'_, AppState>, options: Options) -> Result<(), String> {
    let config = options.validate()?;
    let mut job = state.job.lock().map_err(|e| e.to_string())?;
    if state.snapshot.lock().map_err(|e| e.to_string())?.running {
        return Err("The bridge is already running or stopping".into());
    }
    if job.as_ref().is_some_and(|j| !j.thread.is_finished()) {
        return Err("The bridge is already running".into());
    }
    if let Some(old) = job.take() {
        old.thread
            .join()
            .map_err(|_| "Previous bridge thread panicked")?;
    }
    let shared = state.snapshot.clone();
    *shared.lock().map_err(|e| e.to_string())? = Snapshot {
        running: true,
        last_shot: "none yet".into(),
        sim_reply: "none".into(),
        last_error: "none".into(),
        ..Snapshot::default()
    };
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let worker = thread::spawn(move || {
        let result = bridge::run(config, shared.clone(), flag);
        let mut s = shared.lock().expect("bridge status lock poisoned");
        s.running = false;
        s.open_connect = "Not connected".into();
        s.gspro = None;
        if let Err(error) = result {
            s.last_error = error.clone();
            s.logs.push(format!("fatal: {error}"));
        }
    });
    *job = Some(Job {
        stop,
        thread: worker,
    });
    Ok(())
}

#[tauri::command]
async fn stop(state: State<'_, AppState>) -> Result<(), String> {
    let job = state.job.lock().map_err(|e| e.to_string())?.take();
    if let Some(job) = job {
        job.stop.store(true, Ordering::Relaxed);
        tauri::async_runtime::spawn_blocking(move || {
            job.thread
                .join()
                .map_err(|_| "Bridge thread panicked".to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[tauri::command]
async fn browse(app: tauri::AppHandle, kind: String) -> Result<Option<String>, String> {
    if !["history", "log", "app"].contains(&kind.as_str()) {
        return Err("Invalid file selection".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app.dialog().file();
        let dialog = match kind.as_str() {
            "history" => dialog.add_filter("JSON files", &["json"]),
            "log" => dialog.add_filter("Log files", &["txt", "log"]),
            _ => dialog,
        };
        match dialog.blocking_pick_file() {
            Some(file) => Ok(Some(
                file.into_path()
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .into_owned(),
            )),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("quick-launch.json"))
}

fn read_locations(app: &tauri::AppHandle) -> Result<serde_json::Map<String, Value>, String> {
    let path = settings_path(app)?;
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Default::default()),
        Err(e) => return Err(format!("Cannot read quick launch settings: {e}")),
    };
    serde_json::from_str(&text).map_err(|e| format!("Invalid quick launch settings: {e}"))
}

fn valid_source(source: &str) -> Result<(), String> {
    if source == "gspro" || source == "premier" {
        Ok(())
    } else {
        Err("Invalid launch monitor app".into())
    }
}

#[tauri::command]
fn save_app(app: tauri::AppHandle, source: String, path: String) -> Result<(), String> {
    valid_source(&source)?;
    if path.trim().is_empty() {
        return Err("Application path is empty".into());
    }
    let mut locations = read_locations(&app)?;
    locations.insert(source, Value::String(path));
    let settings = settings_path(&app)?;
    fs::create_dir_all(settings.parent().ok_or("Invalid settings path")?)
        .map_err(|e| e.to_string())?;
    fs::write(
        settings,
        serde_json::to_string_pretty(&locations).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn launch(app: tauri::AppHandle, source: String) -> Result<bool, String> {
    valid_source(&source)?;
    let locations = read_locations(&app)?;
    let saved = locations
        .get(&source)
        .map(|v| {
            v.as_str()
                .filter(|s| !s.is_empty())
                .ok_or("Invalid quick launch settings")
        })
        .transpose()?;
    let defaults = if source == "gspro" {
        vec![PathBuf::from("C:\\GSProV1\\Core\\GSPC\\GSPconnect.exe")]
    } else {
        vec![
            PathBuf::from(std::env::var_os("ProgramData").unwrap_or_default()).join("Microsoft\\Windows\\Start Menu\\Programs\\Foresight Premier\\Foresight Premier.lnk"),
            PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_default()).join("Foresight Premier\\ForesightPremier.exe"),
        ]
    };
    let path = saved
        .map(PathBuf::from)
        .or_else(|| defaults.into_iter().find(|p| p.is_file()));
    let Some(path) = path else {
        return Ok(false);
    };
    let result = if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        std::process::Command::new(&path)
            .current_dir(path.parent().ok_or("Invalid application path")?)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|e| e.to_string())
    };
    result.map_err(|e| {
        format!(
            "Could not open {}: {e}. Use Change location to select the app.",
            path.display()
        )
    })?;
    Ok(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_initial,
            snapshot,
            resize_window,
            start,
            stop,
            browse,
            save_app,
            launch
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
