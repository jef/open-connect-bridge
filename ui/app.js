const invoke = window.__TAURI__.core.invoke;
const byId = (id) => document.getElementById(id);
let lastLogs = [];
let resizeScheduled = false;
let transitionPending = false;

function resizeWindow() {
  if (resizeScheduled) return;
  resizeScheduled = true;
  requestAnimationFrame(async () => {
    resizeScheduled = false;
    try {
      await invoke("resize_window", {
        height: Math.ceil(document.querySelector(".shell").getBoundingClientRect().height),
      });
    } catch (error) {
      showError(error);
    }
  });
}
new ResizeObserver(resizeWindow).observe(document.querySelector(".shell"));
window.addEventListener("resize", resizeWindow);

function source() {
  return document.querySelector('input[name="source"]:checked').value;
}

function showError(error) {
  byId("form-error").textContent = error ? String(error) : "";
}

function updateSource() {
  const isGspro = source() === "gspro";
  byId("gspro-settings").hidden = !isGspro;
  byId("premier-settings").hidden = isGspro;
  byId("gspro-help").hidden = !isGspro;
  byId("premier-help").hidden = isGspro;
  byId("launch-button").textContent = isGspro ? "Open GSPconnect" : "Open Foresight Premier";
}

function render(state) {
  const locked = state.running || transitionPending;
  byId("start-button").disabled = locked;
  byId("stop-button").disabled = !state.running || transitionPending;
  document.querySelectorAll('input[name="source"]').forEach((input) => {
    input.disabled = locked;
  });
  byId("source-lock-note").hidden = !locked;
  byId("live-pill").classList.toggle("running", state.running);
  byId("live-label").textContent = state.running ? "Bridge running" : "Not running";
  byId("target-note").textContent = state.running
    ? "Stop and start the bridge to apply a different target IP or port."
    : "Use the mobile device's IP address if the listener is not on this computer.";
  byId("status-source").textContent = state.source || "—";
  byId("shots").textContent = String(state.shots);
  byId("open-connect").textContent = state.openConnect || "Not connected";
  byId("watching").textContent = state.watching || "Choose a source to begin";
  byId("last-shot").textContent =
    !state.lastShot || state.lastShot === "none yet" ? "Waiting for first shot" : state.lastShot;
  byId("sim-reply").textContent = state.simReply || "—";
  byId("gspro-status").textContent = state.gspro || "—";
  byId("gspro-status").parentElement.hidden = state.gspro === null;
  const hasError = state.lastError && state.lastError !== "none";
  byId("error-banner").hidden = !hasError;
  byId("last-error").textContent = hasError ? state.lastError : "";
  if (JSON.stringify(lastLogs) !== JSON.stringify(state.logs)) {
    lastLogs = state.logs;
    const list = byId("event-list");
    list.replaceChildren();
    for (const line of state.logs) {
      const item = document.createElement("div");
      item.className = "event";
      item.textContent = line;
      list.append(item);
    }
    if (!state.logs.length) list.textContent = "Your connection events will show up here.";
    list.scrollTop = list.scrollHeight;
  }
}

async function chooseApp() {
  const path = await invoke("browse", { kind: "app" });
  if (path) {
    await invoke("save_app", { source: source(), path });
    byId("launch-note").textContent = `Saved: ${path}`;
  }
}

document
  .querySelectorAll('input[name="source"]')
  .forEach((input) => input.addEventListener("change", updateSource));
document.querySelectorAll("[data-browse]").forEach((button) =>
  button.addEventListener("click", async () => {
    try {
      const selected = await invoke("browse", { kind: button.dataset.browse });
      if (selected) byId(button.dataset.browse).value = selected;
    } catch (error) {
      showError(error);
    }
  }),
);
byId("choose-app-button").addEventListener("click", async () => {
  try {
    showError("");
    await chooseApp();
  } catch (error) {
    showError(error);
  }
});
byId("launch-button").addEventListener("click", async () => {
  try {
    showError("");
    if (await invoke("launch", { source: source() }))
      byId("launch-note").textContent = "Launch requested.";
    else {
      await chooseApp();
      if (await invoke("launch", { source: source() }))
        byId("launch-note").textContent = "Launch requested.";
    }
  } catch (error) {
    showError(error);
  }
});
byId("start-button").addEventListener("click", async () => {
  transitionPending = true;
  byId("start-button").disabled = true;
  document.querySelectorAll('input[name="source"]').forEach((input) => {
    input.disabled = true;
  });
  byId("source-lock-note").hidden = false;
  try {
    showError("");
    await invoke("start", {
      options: {
        app: source(),
        host: byId("host").value,
        port: byId("port").value,
        log: byId("log").value,
        history: byId("history").value,
        gsproPort: byId("gspro-port").value,
        heartbeat: byId("heartbeat").value,
      },
    });
  } catch (error) {
    showError(error);
  } finally {
    transitionPending = false;
    try {
      render(await invoke("snapshot"));
    } catch (error) {
      showError(error);
    }
  }
});
byId("stop-button").addEventListener("click", async () => {
  transitionPending = true;
  byId("stop-button").disabled = true;
  try {
    await invoke("stop");
  } catch (error) {
    showError(error);
  } finally {
    transitionPending = false;
    try {
      render(await invoke("snapshot"));
    } catch (error) {
      showError(error);
    }
  }
});

updateSource();
try {
  const initial = await invoke("get_initial");
  byId("log").value = initial.defaults.log;
  byId("history").value = initial.defaults.history;
  render(initial.snapshot);
  setInterval(async () => {
    try {
      render(await invoke("snapshot"));
    } catch (error) {
      showError(error);
    }
  }, 250);
} catch (error) {
  showError(error);
}
