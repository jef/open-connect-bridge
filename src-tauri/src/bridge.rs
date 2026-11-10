use crate::protocol::{self, BallData};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    net::{TcpListener, TcpStream, ToSocketAddrs},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

const MARKER: &str = "Logging ball data IMMEDIATELY before sending to GSPro";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    pub app: String,
    pub host: String,
    pub port: String,
    pub log: String,
    pub history: String,
    pub gspro_port: String,
    pub heartbeat: String,
}

#[derive(Clone)]
pub struct Config {
    pub app: String,
    pub host: String,
    pub port: u16,
    pub file: String,
    pub gspro_port: u16,
    pub heartbeat: Duration,
}

impl Options {
    pub fn validate(self) -> Result<Config, String> {
        if self.app != "gspro" && self.app != "premier" {
            return Err("Choose GSPconnect or Foresight Premier".into());
        }
        let host = self.host.trim().to_owned();
        if host.is_empty() {
            return Err("Open Connect host is required".into());
        }
        let parse_port = |value: &str, label: &str| {
            value
                .trim()
                .parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .ok_or_else(|| format!("{label} must be from 1 to 65535"))
        };
        let port = parse_port(&self.port, "Open Connect port")?;
        let gspro_port = parse_port(&self.gspro_port, "GSPconnect port")?;
        let seconds = self
            .heartbeat
            .trim()
            .parse::<f64>()
            .map_err(|_| "Heartbeat must be a positive number of seconds")?;
        if !seconds.is_finite() || !(0.001..=86400.0).contains(&seconds) {
            return Err("Heartbeat must be between 0.001 and 86400 seconds".into());
        }
        let file = if self.app == "gspro" {
            self.log
        } else {
            self.history
        };
        if file.trim().is_empty() {
            return Err("Source file path is required".into());
        }
        Ok(Config {
            app: self.app,
            host,
            port,
            file: file.trim().into(),
            gspro_port,
            heartbeat: Duration::from_secs_f64(seconds),
        })
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub running: bool,
    pub source: String,
    pub watching: String,
    pub gspro: Option<String>,
    pub open_connect: String,
    pub shots: u64,
    pub last_shot: String,
    pub sim_reply: String,
    pub last_error: String,
    pub logs: Vec<String>,
}

pub type Shared = Arc<Mutex<Snapshot>>;

fn update(shared: &Shared, f: impl FnOnce(&mut Snapshot), log: Option<String>) {
    let mut s = shared.lock().expect("bridge status lock poisoned");
    f(&mut s);
    if let Some(line) = log {
        s.logs.push(line);
        if s.logs.len() > 200 {
            s.logs.remove(0);
        }
    }
}

struct Relay {
    config: Config,
    shared: Shared,
    stream: Option<TcpStream>,
    number: u64,
    next: Instant,
}

impl Relay {
    fn send(&mut self, ball: Option<&BallData>) {
        if let Some(ball) = ball {
            self.number += 1;
            let text = format!(
                "{} mph  VLA {}  HLA {}  spin {}  axis {}",
                ball.speed, ball.vla, ball.hla, ball.total_spin, ball.spin_axis
            );
            update(
                &self.shared,
                |s| {
                    s.shots = self.number;
                    s.last_shot = text.clone();
                },
                Some(format!("shot {}: {text}", self.number)),
            );
        }
        let payload = format!("{}\n", protocol::message(self.number, ball));
        let target = format!("{}:{}", self.config.host, self.config.port);
        for _ in 0..2 {
            let result = (|| -> io::Result<()> {
                if self.stream.is_none() {
                    let addresses =
                        (self.config.host.as_str(), self.config.port).to_socket_addrs()?;
                    let mut error = io::Error::other("host resolved to no addresses");
                    for address in addresses {
                        match TcpStream::connect_timeout(&address, Duration::from_secs(2)) {
                            Ok(socket) => {
                                socket.set_write_timeout(Some(Duration::from_secs(2)))?;
                                socket.set_nonblocking(true)?;
                                self.stream = Some(socket);
                                break;
                            }
                            Err(e) => error = e,
                        }
                    }
                    if self.stream.is_none() {
                        return Err(error);
                    }
                    update(
                        &self.shared,
                        |s| s.open_connect = format!("connected   {target}"),
                        Some(format!("connected to Open Connect {target}")),
                    );
                }
                let socket = self.stream.as_mut().expect("socket connected");
                socket.set_nonblocking(false)?;
                let result = socket.write_all(payload.as_bytes());
                socket.set_nonblocking(true)?;
                result
            })();
            match result {
                Ok(()) => {
                    update(
                        &self.shared,
                        |s| {
                            s.open_connect = format!("connected   {target}");
                            s.last_error = "none".into();
                        },
                        None,
                    );
                    self.next = Instant::now() + self.config.heartbeat;
                    return;
                }
                Err(e) => {
                    let failure = format!("Open Connect send failed ({e}); reconnecting");
                    self.stream = None;
                    update(
                        &self.shared,
                        |s| {
                            s.open_connect = format!("waiting for {target}");
                            s.last_error = failure.clone();
                        },
                        Some(failure.clone()),
                    );
                }
            }
        }
        if ball.is_some() {
            update(
                &self.shared,
                |s| s.last_error = "shot was not delivered; Open Connect listener is down".into(),
                Some("shot was not delivered; Open Connect listener is down".into()),
            );
        }
        self.next = Instant::now() + self.config.heartbeat;
    }

    fn poll_reply(&mut self) {
        if let Some(socket) = &mut self.stream {
            let mut buf = [0; 4096];
            match socket.read(&mut buf) {
                Ok(0) => {
                    self.stream = None;
                    let target = format!("{}:{}", self.config.host, self.config.port);
                    update(
                        &self.shared,
                        |s| s.open_connect = format!("waiting for {target}"),
                        Some(format!("Open Connect disconnected from {target}")),
                    );
                }
                Ok(n) => {
                    let raw = String::from_utf8_lossy(&buf[..n]);
                    let reply = serde_json::from_str::<Value>(&raw)
                        .ok()
                        .and_then(|v| v.get("Message").and_then(Value::as_str).map(str::to_owned))
                        .unwrap_or_else(|| raw.to_string());
                    let short: String = reply
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(80)
                        .collect();
                    update(
                        &self.shared,
                        |s| s.sim_reply = short,
                        Some(format!("sim: {}", raw.trim())),
                    );
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => {
                    self.stream = None;
                    update(
                        &self.shared,
                        |s| {
                            s.last_error = format!("Open Connect read failed: {e}");
                            s.open_connect =
                                format!("waiting for {}:{}", self.config.host, self.config.port);
                        },
                        Some(format!("Open Connect read failed: {e}")),
                    );
                }
            }
        }
    }
}

fn read_history(file: &str) -> Result<Vec<Value>, String> {
    let text = match fs::read_to_string(file) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Cannot read history file: {e}")),
    };
    let payload: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("Waiting for a complete history file: {e}"))?;
    Ok(payload
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn record_id(record: &Value) -> Option<String> {
    let id = record.get("id")?;
    if let Some(s) = id.as_str() {
        if s.is_empty() {
            None
        } else {
            Some(s.to_owned())
        }
    } else if id.is_number() && id.as_f64() != Some(0.0) {
        Some(id.to_string())
    } else {
        None
    }
}

pub fn run(config: Config, shared: Shared, stop: Arc<AtomicBool>) -> Result<(), String> {
    let listener = if config.app == "gspro" {
        let server = TcpListener::bind(("127.0.0.1", config.gspro_port))
            .map_err(|e| format!("Cannot listen for GSPconnect: {e}"))?;
        server.set_nonblocking(true).map_err(|e| e.to_string())?;
        Some(server)
    } else {
        None
    };
    let mut clients: Vec<TcpStream> = Vec::new();
    let mut relay = Relay {
        next: Instant::now() + config.heartbeat,
        config: config.clone(),
        shared: shared.clone(),
        stream: None,
        number: 0,
    };
    let mut pos = None;
    let mut pending = Vec::new();
    let mut waiting = false;
    let mut seen = HashSet::new();
    let mut history_started = false;
    let mut last_file_error = String::new();
    update(
        &shared,
        |s| {
            s.source = if config.app == "gspro" {
                "GSPconnect"
            } else {
                "Foresight Premier"
            }
            .into();
            s.watching = config.file.clone();
            s.open_connect = format!("waiting for {}:{}", config.host, config.port);
            s.gspro = listener
                .as_ref()
                .map(|_| format!("listening on 127.0.0.1:{}", config.gspro_port));
        },
        Some(format!("watching {}", config.file)),
    );
    while !stop.load(Ordering::Relaxed) {
        if let Some(server) = &listener {
            loop {
                match server.accept() {
                    Ok((socket, peer)) => {
                        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
                        clients.push(socket);
                        update(
                            &shared,
                            |s| s.gspro = Some(format!("connected from {peer}")),
                            Some(format!("GSPconnect connected from {peer}")),
                        );
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) => return Err(format!("GSPconnect accept failed: {e}")),
                }
            }
            let had_clients = !clients.is_empty();
            clients.retain_mut(|socket| {
                let mut buf = [0u8; 4096];
                match socket.read(&mut buf) {
                    Ok(0) => false,
                    Ok(_) => true,
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => true,
                    Err(_) => false,
                }
            });
            if had_clients && clients.is_empty() {
                update(
                    &shared,
                    |s| s.gspro = Some(format!("listening on 127.0.0.1:{}", config.gspro_port)),
                    Some("GSPconnect disconnected".into()),
                );
            }
            match File::open(&config.file) {
                Ok(mut file) => {
                    let len = file
                        .metadata()
                        .map_err(|e| format!("Cannot inspect log file: {e}"))?
                        .len();
                    let offset = pos.get_or_insert(len);
                    if len < *offset {
                        *offset = 0;
                        pending.clear();
                        waiting = false;
                    }
                    file.seek(SeekFrom::Start(*offset))
                        .map_err(|e| format!("Cannot seek log: {e}"))?;
                    let mut bytes = Vec::new();
                    file.take(1024 * 1024)
                        .read_to_end(&mut bytes)
                        .map_err(|e| format!("Cannot read log: {e}"))?;
                    *offset += bytes.len() as u64;
                    pending.extend(bytes);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        let text = String::from_utf8_lossy(&line);
                        if text.contains(MARKER) {
                            waiting = true;
                        } else if waiting {
                            waiting = false;
                            if let Some(ball) = protocol::gspro(&text) {
                                relay.send(Some(&ball));
                            }
                        }
                    }
                    last_file_error.clear();
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => {
                    let msg = format!("Cannot open log file: {e}");
                    if msg != last_file_error {
                        update(&shared, |s| s.last_error = msg.clone(), Some(msg.clone()));
                        last_file_error = msg;
                    }
                }
            }
        } else if Path::new(&config.file).parent().is_some_and(Path::exists) {
            match read_history(&config.file) {
                Ok(records) => {
                    for record in records {
                        if let Some(id) = record_id(&record) {
                            if !history_started {
                                seen.insert(id);
                            } else if !seen.contains(&id)
                                && let Some(ball) = protocol::premier(&record)
                            {
                                seen.insert(id);
                                relay.send(Some(&ball));
                            }
                        }
                    }
                    history_started = true;
                    last_file_error.clear();
                }
                Err(msg) => {
                    if msg != last_file_error {
                        update(&shared, |s| s.last_error = msg.clone(), Some(msg.clone()));
                        last_file_error = msg;
                    }
                }
            }
        }
        relay.poll_reply();
        if Instant::now() >= relay.next {
            relay.send(None);
        }
        thread::sleep(Duration::from_millis(200));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn setup(app: &str, file: &Path) -> (TcpListener, Config, Shared, Arc<AtomicBool>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let gspro = TcpListener::bind("127.0.0.1:0").unwrap();
        let gspro_port = gspro.local_addr().unwrap().port();
        drop(gspro);
        let config = Config {
            app: app.into(),
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            file: file.to_string_lossy().into_owned(),
            gspro_port,
            heartbeat: Duration::from_millis(300),
        };
        (
            listener,
            config,
            Arc::new(Mutex::new(Snapshot::default())),
            Arc::new(AtomicBool::new(false)),
        )
    }

    fn read_message(reader: &mut BufReader<TcpStream>, shot: bool) -> Value {
        for _ in 0..15 {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let value: Value = serde_json::from_str(&line).unwrap();
            if value["ShotDataOptions"]["ContainsBallData"] == shot {
                return value;
            }
        }
        panic!("Expected message not received");
    }

    #[test]
    fn gspro_tails_new_shots_and_sends_heartbeats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connect.log");
        fs::write(&path, format!("{MARKER}\n[99,1,1,1,1,1,1,0]\n")).unwrap();
        let (listener, config, shared, stop) = setup("gspro", &path);
        let flag = stop.clone();
        let worker = thread::spawn(move || run(config, shared, flag));
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        assert_eq!(read_message(&mut reader, false)["ShotNumber"], 0);
        let mut log = fs::OpenOptions::new().append(true).open(path).unwrap();
        write!(
            log,
            "{MARKER}\n[82.3337,19.9920921,1.68702,1161,6899.38574,6801,9.687589,0]\n"
        )
        .unwrap();
        let shot = read_message(&mut reader, true);
        assert_eq!(shot["ShotNumber"], 1);
        assert_eq!(shot["BallData"]["VLA"], 19.9921);
        assert_eq!(shot["BallData"]["Speed"], 82.3337);
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn premier_skips_existing_records_and_sends_new_shots_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        let old = json_record("old", 70);
        fs::write(&path, serde_json::json!({"records":[old]}).to_string()).unwrap();
        let (listener, config, shared, stop) = setup("premier", &path);
        let flag = stop.clone();
        let worker = thread::spawn(move || run(config, shared, flag));
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        assert_eq!(read_message(&mut reader, false)["ShotNumber"], 0);
        fs::write(
            &path,
            serde_json::json!({"records":[json_record("old",70),json_record("new",90)]})
                .to_string(),
        )
        .unwrap();
        let shot = read_message(&mut reader, true);
        assert_eq!(shot["ShotNumber"], 1);
        assert_eq!(shot["BallData"]["Speed"], 90.0);
        assert_eq!(read_message(&mut reader, false)["ShotNumber"], 1);
        stop.store(true, Ordering::Relaxed);
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn busy_gspro_port_reports_startup_failure() {
        let dir = tempfile::tempdir().unwrap();
        let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
        let (_, mut config, shared, stop) = setup("gspro", &dir.path().join("log"));
        config.gspro_port = occupied.local_addr().unwrap().port();
        let error = run(config, shared, stop).unwrap_err();
        assert!(error.contains("Cannot listen for GSPconnect"), "{error}");
    }

    #[test]
    fn unavailable_listener_reports_missed_shot() {
        let dir = tempfile::tempdir().unwrap();
        let (listener, config, shared, _) = setup("gspro", &dir.path().join("log"));
        drop(listener);
        let mut relay = Relay {
            next: Instant::now(),
            config,
            shared: shared.clone(),
            stream: None,
            number: 0,
        };
        let ball = protocol::gspro("[80,10,1,0,0,0,0,0]").unwrap();
        relay.send(Some(&ball));
        let snapshot = shared.lock().unwrap();
        assert_eq!(snapshot.shots, 1);
        assert!(snapshot.last_error.contains("shot was not delivered"));
        assert!(snapshot.open_connect.starts_with("waiting for "));
    }

    #[test]
    fn partially_written_history_can_be_retried() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.json");
        fs::write(&path, "{\"records\": [").unwrap();
        let name = path.to_str().unwrap();
        assert!(read_history(name).is_err());
        fs::write(
            &path,
            serde_json::json!({"records":[json_record("new",90)]}).to_string(),
        )
        .unwrap();
        assert_eq!(read_history(name).unwrap().len(), 1);
    }

    fn json_record(id: &str, speed: u32) -> Value {
        serde_json::json!({"id":id,"ballSpeedMPH":speed,"launchAngleDeg":10,"azimuthDeg":0})
    }
}
