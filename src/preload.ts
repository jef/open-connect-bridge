import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("bridge", {
  getInitial: () => ipcRenderer.invoke("bridge:get-initial"),
  start: (options: unknown) => ipcRenderer.invoke("bridge:start", options),
  stop: () => ipcRenderer.invoke("bridge:stop"),
  browse: (kind: "log" | "history") => ipcRenderer.invoke("bridge:browse", kind),
  launch: (source: "gspro" | "premier") => ipcRenderer.invoke("bridge:launch", source),
  chooseApp: (source: "gspro" | "premier") => ipcRenderer.invoke("bridge:choose-app", source),
  resizeWindow: (height: number) => ipcRenderer.send("bridge:resize-window", height),
  onMeasureWindow: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("bridge:measure-window", listener);
    return () => ipcRenderer.removeListener("bridge:measure-window", listener);
  },
  onStatus: (callback: (value: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: unknown) => callback(value);
    ipcRenderer.on("bridge:status", listener);
    return () => ipcRenderer.removeListener("bridge:status", listener);
  },
  onLog: (callback: (value: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: string) => callback(value);
    ipcRenderer.on("bridge:log", listener);
    return () => ipcRenderer.removeListener("bridge:log", listener);
  },
  onRunning: (callback: (value: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: boolean) => callback(value);
    ipcRenderer.on("bridge:running", listener);
    return () => ipcRenderer.removeListener("bridge:running", listener);
  },
});
