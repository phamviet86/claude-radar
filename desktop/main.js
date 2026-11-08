// Claude Radar as a Mac app: runs the local read-only server inside the app and shows the board window.
// Closing the window only hides it; the menu-bar icon shows INPUT and RUN and reopens the window on click.
import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createBoardServer } from '../server.js';
import { SessionReader } from '../lib/read.js';
import { QuotaService } from '../lib/quotas.js';
import { KeyStore, KEY_NAMES } from './keystore.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4858; // fixed port: localStorage (saved filters) is tied to the origin
let win = null;
let keysWin = null;
let tray = null;
let base = '';
const KEYS_URL = 'claude-radar://keys';
let quitting = false;

// the app used to be called Thread Board: carry its settings folder (the saved filters) over to the new name
const appData = app.getPath('appData');
if (existsSync(join(appData, 'thread-board')) && !existsSync(join(appData, 'claude-radar'))) {
  try {
    renameSync(join(appData, 'thread-board'), join(appData, 'claude-radar'));
  } catch {
    /* expected when the folder is in use: the app starts with fresh settings */
  }
}

// opt-in quotas: FIRECRAWL_API_KEY may live in a .env next to the source (npm run app) or in the app's settings folder (built .app);
// a variable already set in the environment wins (loadEnvFile never overrides it)
for (const f of [join(dir, '..', '.env'), join(appData, 'claude-radar', '.env')]) {
  try {
    if (existsSync(f)) process.loadEnvFile(f);
  } catch {
    /* expected: unreadable file, the quotas card stays "Off" */
  }
}

// keys entered in the app (Quotas > API keys...) are stored encrypted (Keychain) and override .env / the environment while saved
const envBefore = Object.fromEntries(KEY_NAMES.map((n) => [n, process.env[n]]));
const keyStore = new KeyStore({ file: join(appData, 'claude-radar', 'keys.json'), safeStorage });
const reader = new SessionReader();
const quotas = new QuotaService({ projectsDir: reader.projectsDir });

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function listen() {
  const server = createBoardServer(reader, Date.now, quotas);
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && port !== 0 ? attempt(0) : reject(e)));
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    };
    attempt(PORT);
  });
}

function applyStoredKeys() {
  try {
    for (const [name, value] of Object.entries(keyStore.load())) process.env[name] = value;
  } catch {
    /* expected: Keychain unavailable; the quotas cards stay as the environment says */
  }
  quotas.reset();
}

function showKeys() {
  if (keysWin) { keysWin.show(); keysWin.focus(); return; }
  keysWin = new BrowserWindow({
    width: 480, height: 400, resizable: false, minimizable: false, maximizable: false, title: 'API keys', backgroundColor: '#040a14',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: join(dir, 'preload.cjs') },
  });
  keysWin.setMenuBarVisibility(false);
  keysWin.loadFile(join(dir, 'keys.html'));
  // this window never navigates or opens anything else
  keysWin.webContents.on('will-navigate', (e) => e.preventDefault());
  keysWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  keysWin.on('closed', () => { keysWin = null; });
}

// tell the board window a key changed, so the footer refreshes now instead of at its next poll
function keysChanged() {
  quotas.reset();
  win?.webContents.executeJavaScript("window.dispatchEvent(new Event('claude-radar:keys'))").catch(() => {});
}

// only the API keys window may talk to the key store, and it can never read a key back
const fromKeysWindow = (e) => keysWin && e.sender === keysWin.webContents;
ipcMain.handle('keys:status', (e) => { if (!fromKeysWindow(e)) throw new Error('Not allowed.'); return keyStore.status(); });
ipcMain.handle('keys:save', (e, name, value) => {
  if (!fromKeysWindow(e)) throw new Error('Not allowed.');
  process.env[name] = keyStore.set(name, value);
  keysChanged();
  return keyStore.status();
});
ipcMain.handle('keys:clear', (e, name) => {
  if (!fromKeysWindow(e)) throw new Error('Not allowed.');
  keyStore.remove(name);
  if (envBefore[name] === undefined) delete process.env[name]; else process.env[name] = envBefore[name]; // back to .env / the environment
  keysChanged();
  return keyStore.status();
});

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 360, minHeight: 480, title: 'Claude Radar', backgroundColor: '#040a14', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 },
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // app only: the top bar becomes the title bar (drags the window) and leaves room for the red/yellow/green buttons
  win.webContents.on('did-finish-load', () => win.webContents.insertCSS(`
    .topbar { -webkit-app-region: drag; }
    .topbar button, .topbar a, .topbar .tabs, .topbar .sb-counts { -webkit-app-region: no-drag; }
    .topbar .brand { margin-left: 72px; }
    @media (max-width: 720px) { .topbar .brand { margin-left: 72px; } }`));
  win.loadURL(base);
  // claude://... and external links open outside the app; the window never leaves the local server
  const external = (url) => !url.startsWith(base);
  // the footer's "ENABLE" button asks for the API keys window with window.open('claude-radar://keys')
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === KEYS_URL) showKeys(); else shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url === KEYS_URL) { e.preventDefault(); showKeys(); } else if (external(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

async function updateTray() {
  try {
    const board = await (await fetch(`${base}/api/board`)).json();
    const n = { input: 0, work: 0 };
    for (const g of board.groups) for (const m of [g, ...g.children]) if (m.status in n) n[m.status] += 1;
    tray.setTitle(n.input || n.work ? ` ${n.input} · ${n.work}` : '');
    tray.setToolTip(`Claude Radar: ${n.input} need input, ${n.work} running`);
  } catch {
    // the built-in server could not be reached: show × in the menu bar
    tray.setTitle(' ×');
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Claude Radar', click: showWindow },
    { type: 'separator' },
    { label: 'API keys…', click: showKeys },
    { label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
  ]);
}

app.whenReady().then(async () => {
  applyStoredKeys();
  base = `http://127.0.0.1:${await listen()}`;
  const icon = nativeImage.createFromPath(join(dir, 'iconTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Quotas', submenu: [{ label: 'API keys…', accelerator: 'Cmd+,', click: showKeys }] },
  ]));
  createWindow();
  updateTray();
  setInterval(updateTray, 2000);
});
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* keep running in the menu bar */ });
