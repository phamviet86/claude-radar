// `npm run demo`: the board with made-up threads, no Claude desktop needed. Nothing real is read or written.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoardServer } from '../server.js';
import { SessionReader } from '../lib/read.js';
import { demoQuotas, writeDemo } from './data.mjs';

const dir = mkdtempSync(join(tmpdir(), 'claude-radar-demo-'));
const reader = new SessionReader(writeDemo(dir));
const port = Number(process.env.PORT) || 4868;
createBoardServer(reader, Date.now, demoQuotas()).listen(port, '127.0.0.1', () => console.log(`Claude Radar demo (made-up data) at http://127.0.0.1:${port}`));
