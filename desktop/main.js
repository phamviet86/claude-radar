// Thread Board as a Mac app: runs the local read-only server inside the app and shows the board window.
// Closing the window only hides it; the menu-bar icon shows INPUT and RUN and reopens the window on click.
import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createBoardServer } from '../server.js';

const dir = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4858; // fixed port: localStorage (saved filters) is tied to the origin
let win = null;
let tray = null;
let base = '';
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function listen() {
  const server = createBoardServer();
  return new Promise((resolve, reject) => {
    const attempt = (port) => {
      server.once('error', (e) => (e.code === 'EADDRINUSE' && port !== 0 ? attempt(0) : reject(e)));
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    };
    attempt(PORT);
  });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 360, minHeight: 480, title: 'Thread Board', backgroundColor: '#040a14', show: false,
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
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (external(url)) { e.preventDefault(); shell.openExternal(url); } });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

async function updateTray() {
  try {
    const board = await (await fetch(`${base}/api/board`)).json();
    const n = { input: 0, work: 0 };
    for (const g of board.groups) for (const m of [g, ...g.children]) if (m.status in n) n[m.status] += 1;
    tray.setTitle(n.input || n.work ? ` ${n.input} · ${n.work}` : '');
    tray.setToolTip(`Thread Board: ${n.input} need input, ${n.work} running`);
  } catch {
    // the built-in server could not be reached: show × in the menu bar
    tray.setTitle(' ×');
  }
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Thread Board', click: showWindow },
    { type: 'separator' },
    { label: 'Launch at login', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (i) => app.setLoginItemSettings({ openAtLogin: i.checked }) },
    { type: 'separator' },
    { label: 'Quit', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
  ]);
}

app.whenReady().then(async () => {
  base = `http://127.0.0.1:${await listen()}`;
  const icon = nativeImage.createFromPath(join(dir, 'iconTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow();
  updateTray();
  setInterval(updateTray, 2000);
});
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* keep running in the menu bar */ });
