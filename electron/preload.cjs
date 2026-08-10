"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const statusListeners = new Set();
const navigateListeners = new Set();

ipcRenderer.on("pi-webview-status", (_event, info) => {
  for (const listener of statusListeners) listener(info);
});

ipcRenderer.on("pi-webview-navigated", (_event, info) => {
  for (const listener of navigateListeners) listener(info);
});

contextBridge.exposeInMainWorld("piElectron", {
  isElectron: true,
  webview: {
    create: (tabId) => ipcRenderer.invoke("pi-webview-create", tabId),
    destroy: (tabId) => ipcRenderer.invoke("pi-webview-destroy", tabId),
    setVisible: (tabId, visible) => ipcRenderer.send("pi-webview-visible", tabId, visible),
    setBounds: (tabId, bounds) => ipcRenderer.send("pi-webview-bounds", tabId, bounds),
    navigate: (tabId, url) => ipcRenderer.invoke("pi-webview-navigate", tabId, url),
    back: (tabId) => ipcRenderer.invoke("pi-webview-back", tabId),
    forward: (tabId) => ipcRenderer.invoke("pi-webview-forward", tabId),
    reload: (tabId) => ipcRenderer.invoke("pi-webview-reload", tabId),
    getInfo: (tabId) => ipcRenderer.invoke("pi-webview-info", tabId),
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onNavigate: (listener) => {
      navigateListeners.add(listener);
      return () => navigateListeners.delete(listener);
    },
  },
});
