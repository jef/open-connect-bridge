pub mod bridge;
mod launch;
mod platform;
mod protocol;
mod window;

use bridge::{Options, Shared, Snapshot, lock};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
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
        .map(PathBuf::from);
    let (log, history) = platform::default_source_files(cfg!(windows), home.as_deref());
    let snapshot = lock(&state.snapshot).clone();
    Ok(json!({"defaults":{"log":log,"history":history},"snapshot":snapshot}))
}

#[tauri::command]
fn snapshot(state: State<'_, AppState>) -> Snapshot {
    lock(&state.snapshot).clone()
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
    let target = window::fit_height(desired, frame, available.size.height);
    if target != inner.height {
        window
            .set_size(tauri::PhysicalSize::new(inner.width, target))
            .map_err(|e| e.to_string())?;
        let position = window.outer_position().map_err(|e| e.to_string())?;
        let outer = window.outer_size().map_err(|e| e.to_string())?;
        let y = window::clamp_y(
            position.y,
            outer.height,
            available.position.y,
            available.size.height,
        );
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
    if lock(&state.snapshot).running {
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
    *lock(&shared) = Snapshot {
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
        let mut s = lock(&shared);
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

#[tauri::command]
fn save_app(app: tauri::AppHandle, source: String, path: String) -> Result<(), String> {
    launch::save_location(&settings_path(&app)?, &source, &path)
}

#[tauri::command]
fn launch(app: tauri::AppHandle, source: String) -> Result<bool, String> {
    launch::valid_source(&source)?;
    let locations = launch::read_locations(&settings_path(&app)?)?;
    let saved = launch::saved_location(&locations, &source)?;
    let program_data = std::env::var_os("ProgramData").map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    let defaults = platform::default_app_locations(
        &source,
        cfg!(windows),
        program_data.as_deref(),
        program_files.as_deref(),
    );
    let Some(path) = launch::resolve(saved, defaults) else {
        return Ok(false);
    };
    let result = if launch::starts_directly(&path) {
        let folder = path.parent().unwrap_or(Path::new("."));
        std::process::Command::new(&path)
            .current_dir(folder)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .open_path(path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|e| e.to_string())
    };
    result.map_err(|e| launch::open_error(&path, e))?;
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
