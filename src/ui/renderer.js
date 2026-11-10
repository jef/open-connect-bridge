const bridgeApi = window.bridge;
const byId = (id) => document.getElementById(id);
const shell = document.querySelector(".shell");
let resizeScheduled = false;

function resizeToContent() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(() => {
    resizeScheduled = false;
    bridgeApi.resizeWindow(Math.ceil(shell.getBoundingClientRect().height));
  });
}

const resizeObserver = new ResizeObserver(resizeToContent);
resizeObserver.observe(shell);
bridgeApi.onMeasureWindow(resizeToContent);

function selectedSource() {
  return document.querySelector('input[name="source"]:checked').value;
}

function updateSourceFields() {
  const gspro = selectedSource() === "gspro";
  byId("gspro-settings").hidden = !gspro;
  byId("premier-settings").hidden = gspro;
  byId("gspro-help").hidden = !gspro;
  byId("premier-help").hidden = gspro;
  byId("launch-button").textContent = gspro ? "Open GSPconnect" : "Open Foresight Premier";
  byId("launch-note").textContent = "Uses the default location, or asks you to choose the app.";
}

function setRunning(value) {
  byId("start-button").disabled = value;
  byId("stop-button").disabled = !value;
  byId("live-pill").classList.toggle("running", value);
  byId("live-label").textContent = value ? "Bridge running" : "Not running";
  byId("target-note").textContent = value
    ? "Stop and start the bridge to apply a different target IP or port."
    : "Use the mobile device's IP address if the listener is not on this computer.";
}

function showStatus(status) {
  if (!status) return;
  byId("status-source").textContent = status.source || "—";
  byId("shots").textContent = String(status.shots ?? 0);
  byId("open-connect").textContent = status.openConnect || "Not connected";
  byId("watching").textContent = status.watching || "Choose a source to begin";
  byId("watching").title = status.watching || "";
  byId("last-shot").textContent =
    status.lastShot === "none yet" ? "Waiting for first shot" : status.lastShot;
  byId("last-shot").title = status.lastShot || "";
  byId("sim-reply").textContent = status.simReply || "—";
  byId("gspro-status").textContent = status.gspro || "—";
  byId("gspro-status").parentElement.hidden = status.gspro === null;
  const hasError = status.lastError && status.lastError !== "none";
  byId("error-banner").hidden = !hasError;
  byId("last-error").textContent = hasError ? status.lastError : "";
}

function addLog(line) {
  const list = byId("event-list");
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();
  const item = document.createElement("div");
  item.className = "event";
  const time = document.createElement("span");
  time.className = "event-time";
  time.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const text = document.createElement("span");
  text.textContent = line;
  item.append(time, text);
  list.append(item);
  while (list.children.length > 100) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}

function showError(message) {
  byId("form-error").textContent = message instanceof Error ? message.message : String(message);
}

function readOptions() {
  return {
    app: selectedSource(),
    host: byId("host").value,
    port: byId("port").value,
    log: byId("log").value,
    history: byId("history").value,
    gsproPort: byId("gspro-port").value,
    heartbeat: byId("heartbeat").value,
  };
}

byId("launch-button").addEventListener("click", async () => {
  const button = byId("launch-button");
  button.disabled = true;
  showError("");
  try {
    const opened = await bridgeApi.launch(selectedSource());
    if (opened) byId("launch-note").textContent = "Launch requested.";
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

byId("choose-app-button").addEventListener("click", async () => {
  showError("");
  try {
    const file = await bridgeApi.chooseApp(selectedSource());
    if (file) byId("launch-note").textContent = `Saved: ${file}`;
  } catch (error) {
    showError(error);
  }
});

document
  .querySelectorAll('input[name="source"]')
  .forEach((input) => input.addEventListener("change", updateSourceFields));
document.querySelectorAll("[data-browse]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      const kind = button.dataset.browse;
      const selected = await bridgeApi.browse(kind);
      if (selected) byId(kind).value = selected;
    } catch (error) {
      showError(error);
    }
  });
});

byId("start-button").addEventListener("click", async () => {
  showError("");
  try {
    await bridgeApi.start(readOptions());
  } catch (error) {
    showError(error);
  }
});

byId("stop-button").addEventListener("click", async () => {
  try {
    await bridgeApi.stop();
  } catch (error) {
    showError(error);
  }
});

bridgeApi.onStatus(showStatus);
bridgeApi.onLog(addLog);
bridgeApi.onRunning(setRunning);
bridgeApi
  .getInitial()
  .then((initial) => {
    byId("log").value = initial.defaults.log;
    byId("history").value = initial.defaults.history;
    showStatus(initial.status);
    initial.logs.forEach(addLog);
    setRunning(initial.running);
  })
  .catch(showError);
updateSourceFields();
