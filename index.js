const { app, BrowserWindow, ipcMain, nativeImage, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
const AI_FEED_PATH = path.join(__dirname, 'live_feed.png');
const PREFS_PATH = path.join(app.getPath('userData'), 'vipedroid-prefs.json');
const CAPTURE_INTERVAL_MS = 3000;
const MAX_URL_HISTORY = 20;

// ─── Persistent preferences ──────────────────────────────────────────────────
function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_PATH)) return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
  } catch (_) {}
  return { lastUrl: 'http://localhost:5173', urlHistory: [], captureEnabled: true, alwaysOnTop: true };
}

function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2)); } catch (_) {}
}

// ─── Main window ─────────────────────────────────────────────────────────────
function createWindow() {
  const prefs = loadPrefs();
  const args = process.argv.slice(2);
  const targetUrl = args[0] || prefs.lastUrl || `file://${path.join(__dirname, 'index.html')}`;

  mainWindow = new BrowserWindow({
    width: 440,
    height: 900,
    minWidth: 360,
    minHeight: 700,
    frame: false,
    transparent: true,
    alwaysOnTop: prefs.alwaysOnTop !== false,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      spellcheck: false
    }
  });

  // Remove default menu bar
  Menu.setApplicationMenu(null);

  if (targetUrl.startsWith('http')) {
    mainWindow.loadFile('index.html');
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('load-url', targetUrl);
      mainWindow.webContents.send('prefs', prefs);
    });
  } else {
    mainWindow.loadURL(targetUrl);
  }

  // ── AI Vision Bridge ──────────────────────────────────────────────────────
  let captureTimer = null;

  function startCapture() {
    if (captureTimer) return;
    captureTimer = setInterval(async () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const image = await mainWindow.webContents.capturePage();
        const png = image.toPNG();
        fs.writeFileSync(AI_FEED_PATH, png);
        mainWindow.webContents.send('ai-feed-updated', {
          path: AI_FEED_PATH,
          size: png.length,
          timestamp: Date.now()
        });
      } catch (_) {}
    }, CAPTURE_INTERVAL_MS);
  }

  function stopCapture() {
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  }

  if (prefs.captureEnabled !== false) startCapture();

  // ── IPC: Window controls ──────────────────────────────────────────────────
  ipcMain.on('win-close',    () => mainWindow && mainWindow.close());
  ipcMain.on('win-minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.on('win-pin-toggle', (_, pin) => {
    if (!mainWindow) return;
    mainWindow.setAlwaysOnTop(pin);
    const p = loadPrefs(); p.alwaysOnTop = pin; savePrefs(p);
  });

  // ── IPC: Navigation ───────────────────────────────────────────────────────
  ipcMain.on('url-navigated', (_, url) => {
    const p = loadPrefs();
    p.lastUrl = url;
    if (!p.urlHistory) p.urlHistory = [];
    p.urlHistory = [url, ...p.urlHistory.filter(u => u !== url)].slice(0, MAX_URL_HISTORY);
    savePrefs(p);
  });

  ipcMain.handle('get-history', () => loadPrefs().urlHistory || []);

  ipcMain.on('clear-history', () => {
    const p = loadPrefs(); p.urlHistory = []; savePrefs(p);
    mainWindow && mainWindow.webContents.send('prefs', p);
  });

  // ── IPC: DevTools toggle ──────────────────────────────────────────────────
  ipcMain.on('toggle-devtools', () => {
    if (!mainWindow) return;
    mainWindow.webContents.isDevToolsOpened()
      ? mainWindow.webContents.closeDevTools()
      : mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // ── IPC: AI capture toggle ────────────────────────────────────────────────
  ipcMain.on('capture-toggle', (_, enabled) => {
    const p = loadPrefs(); p.captureEnabled = enabled; savePrefs(p);
    enabled ? startCapture() : stopCapture();
  });

  // ── IPC: Open feed file in system viewer ─────────────────────────────────
  ipcMain.on('open-feed', () => {
    if (fs.existsSync(AI_FEED_PATH)) shell.openPath(AI_FEED_PATH);
  });

  mainWindow.on('closed', () => {
    stopCapture();
    ipcMain.removeAllListeners();
    mainWindow = null;
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
