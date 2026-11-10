use open_connect_bridge_lib::bridge::{self, Options, Snapshot};
use std::{
    env,
    io::{self, IsTerminal, Write},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

const HELP: &str = "Open Connect bridge\n\nUsage: bridge-cli [--app gspro|premier] [--log path] [--history path] [--host host] [--port port] [--gspro-port port] [--heartbeat seconds]\nPress Ctrl+C to stop.";

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let home = env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .ok_or("Cannot find home directory")?;
    let history = PathBuf::from(home)
        .join("AppData")
        .join("LocalLow")
        .join("Foresight Sports")
        .join("Foresight Premier")
        .join("ShotReplay")
        .join("history.json");
    let mut options = Options {
        app: String::new(),
        host: "127.0.0.1".into(),
        port: "921".into(),
        log: "C:\\GSProV1\\Core\\GSPC\\ConnectDebug.txt".into(),
        history: history.to_string_lossy().into_owned(),
        gspro_port: "9050".into(),
        heartbeat: "5".into(),
    };
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!("{HELP}");
            return Ok(());
        }
        let value = args
            .next()
            .ok_or_else(|| format!("{arg} requires a value"))?;
        match arg.as_str() {
            "--app" => options.app = value,
            "--log" => options.log = value,
            "--history" => options.history = value,
            "--host" => options.host = value,
            "--port" => options.port = value,
            "--gspro-port" => options.gspro_port = value,
            "--heartbeat" => options.heartbeat = value,
            _ => return Err(format!("Unknown option: {arg}")),
        }
    }
    if options.app.is_empty() {
        if !io::stdin().is_terminal() {
            return Err("Pass --app gspro or premier".into());
        }
        print!("Choose source: 1) GSPconnect  2) Foresight Premier: ");
        io::stdout().flush().map_err(|e| e.to_string())?;
        let mut answer = String::new();
        io::stdin()
            .read_line(&mut answer)
            .map_err(|e| e.to_string())?;
        options.app = match answer.trim().to_lowercase().as_str() {
            "1" | "gspro" | "gsp" | "gspconnect" => "gspro",
            "2" | "premier" => "premier",
            _ => return Err("Choose GSPconnect or Foresight Premier".into()),
        }
        .into();
    }
    let config = options.validate()?;
    let state = Arc::new(Mutex::new(Snapshot::default()));
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed)).map_err(|e| e.to_string())?;
    let shared = state.clone();
    let flag = stop.clone();
    let worker = thread::spawn(move || bridge::run(config, shared, flag));
    while !worker.is_finished() {
        {
            let mut snapshot = state.lock().map_err(|e| e.to_string())?;
            for line in snapshot.logs.drain(..) {
                println!("{line}");
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    worker.join().map_err(|_| "Bridge thread panicked")??;
    println!("stopped");
    Ok(())
}
