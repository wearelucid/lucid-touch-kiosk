// Preload for the setup (display-picker) window and the test page. Exposes a
// tiny API so they can choose a display, live-preview zoom, and launch.
const { contextBridge, ipcRenderer, webFrame } = require('electron')

contextBridge.exposeInMainWorld('lucidKiosk', {
  // window 1: pick a display → opens the test page on it
  chooseDisplay: (index) => ipcRenderer.invoke('setup:chooseDisplay', index),
  // window 2 (test page): persist a partial config (e.g. {zoom} or {url})
  save: (partial) => ipcRenderer.invoke('kiosk:save', partial),
  // window 2 (test page): save url/zoom + launch the kiosk
  launch: (opts) => ipcRenderer.invoke('kiosk:launch', opts),
  // window 2: receive touch-agent diagnostics (HID devices, status, live reports)
  onDiag: (cb) => {
    ipcRenderer.on('kiosk:diag', (_e, ev) => cb(ev))
  },
  // window 2: diagnostics actions
  openInputMonitoring: () => ipcRenderer.invoke('kiosk:openInputMonitoring'),
  rescan: () => ipcRenderer.invoke('kiosk:rescan'),
  relaunch: () => ipcRenderer.invoke('kiosk:relaunch'),
  // window 2: panel wizard — derive a touchReport from WebHID descriptors,
  // and persist the result (vid/pid + layout); the window reloads after save
  deriveLayout: (devices) => ipcRenderer.invoke('kiosk:deriveLayout', devices),
  savePanel: (p) => ipcRenderer.invoke('kiosk:savePanel', p),
  // window 2: escape hatch when deriveLayout fails — dump the raw descriptors
  // (same devices array) to a file so an unknown panel can be profiled by hand
  dumpDescriptors: (devices) => ipcRenderer.invoke('kiosk:dumpDescriptors', devices),
  // window 2: live-preview the page zoom on the test page itself
  setZoom: (factor) => {
    try {
      webFrame.setZoomFactor(Number(factor) || 1)
    } catch {
      /* ignore */
    }
  },
})
