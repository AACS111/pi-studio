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
  openUploadsDir: () => ipcRenderer.invoke("pi-open-uploads-dir"),
  // 在资源管理器中显示指定文件（变更/生成文件卡的 📁 按钮，主进程原生置前）。
  revealFile: (filePath) => ipcRenderer.invoke("pi-reveal-path", filePath),
  // 任务区「文件/表格」卡片：主进程原生「打开文件」对话框，返回用户挑选的真实
  // 绝对路径（ canceled=true 表示用户取消）。仅 Electron 桌面模式存在。
  pickOpenFile: (opts) => ipcRenderer.invoke("pi-pick-open-file", opts),
  // 自定义窗口控制（WindowControls 组件使用，原生控件已通过 titleBarOverlay:false 关闭）。
  window: {
    minimize: () => ipcRenderer.send("pi-window-minimize"),
    toggleMaximize: () => ipcRenderer.invoke("pi-window-maximize-toggle"),
    close: () => ipcRenderer.send("pi-window-close"),
    isMaximized: () => ipcRenderer.invoke("pi-window-is-maximized"),
    onMaximizedChange: (listener) => {
      const wrapped = (_event, maximized) => listener(Boolean(maximized));
      ipcRenderer.on("pi-window-maximized", wrapped);
      return () => ipcRenderer.removeListener("pi-window-maximized", wrapped);
    },
  },
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
