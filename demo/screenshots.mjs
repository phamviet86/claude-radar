// `npm run screenshots`: regenerates the README images in docs/ from the made-up demo data (Electron, offscreen).
import { app, BrowserWindow } from 'electron';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoardServer } from '../server.js';
import { SessionReader } from '../lib/read.js';
import { demoQuotas, writeDemo } from './data.mjs';

const out = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'docs');
mkdirSync(out, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {}); // stay alive between pictures; the script quits itself

app.whenReady().then(async () => {
  const reader = new SessionReader(writeDemo(mkdtempSync(join(tmpdir(), 'claude-radar-shots-'))));
  const server = createBoardServer(reader, Date.now, demoQuotas());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  /** One window per picture: load the page, let the effects settle, run `prepare`, save a PNG. */
  async function shot(name, width, height, prepare = '') {
    const win = new BrowserWindow({ width, height, show: false, backgroundColor: '#040a14', webPreferences: { backgroundThrottling: false } });
    await win.loadURL(url);
    await wait(1800);
    await win.webContents.executeJavaScript(`document.documentElement.style.overflow = 'hidden'; ${prepare}`); // no scrollbar in the picture
    await wait(1200);
    const image = await win.webContents.capturePage();
    const { width: w } = image.getSize();
    writeFileSync(join(out, `${name}.png`), (w > width * 1.5 ? image.resize({ width: width * 1.5 }) : image).toPNG());
    win.destroy();
    console.log('saved', `docs/${name}.png`);
  }

  await shot('board', 1280, 760);
  await shot('drawer', 1280, 760, `openDrawer('local_demo-docs')`);
  await shot('narrow', 390, 760);
  server.close();
  app.quit();
});
