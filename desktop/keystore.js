// API keys entered in the Mac app. Stored encrypted with Electron's safeStorage (the key lives in the macOS Keychain),
// in one owner-only file in the app's settings folder. A key is never written in plain text: if encryption is not
// available the save is refused. The page never sees a saved key; only whether one exists.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const KEY_NAMES = ['FIRECRAWL_API_KEY', 'CRAWL4AI_API_KEY'];
const VALUE = /^[\w.\-]{8,512}$/; // fc-..., sk_live_...: no spaces or newlines

export class KeyStore {
  /**
   * @param {{file: string, safeStorage: {isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string}}} opts
   */
  constructor({ file, safeStorage }) {
    this.file = file;
    this.safe = safeStorage;
  }

  #read() {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {}; // expected: nothing saved yet
    }
  }

  #write(obj) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** Decrypted keys that are saved and allowed: {NAME: value}. */
  load() {
    const out = {};
    const raw = this.#read();
    for (const name of KEY_NAMES) {
      if (typeof raw[name] !== 'string') continue;
      try {
        out[name] = this.safe.decryptString(Buffer.from(raw[name], 'base64'));
      } catch {
        /* expected: saved on another Mac/user or the Keychain entry changed: treat as not saved */
      }
    }
    return out;
  }

  /** Which keys are saved: {NAME: true|false}. Never the values. */
  status() {
    const raw = this.#read();
    return Object.fromEntries(KEY_NAMES.map((n) => [n, typeof raw[n] === 'string']));
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  set(name, value) {
    if (!KEY_NAMES.includes(name)) throw new Error('Unknown key name.');
    const v = String(value ?? '').trim();
    if (!VALUE.test(v)) throw new Error('The key looks invalid (letters, digits, "-", "_", "."; 8 to 512 characters).');
    if (!this.safe.isEncryptionAvailable()) throw new Error('Secure storage is not available, so the key was not saved.');
    const raw = this.#read();
    raw[name] = this.safe.encryptString(v).toString('base64');
    this.#write(raw);
    return v;
  }

  /** @param {string} name */
  remove(name) {
    if (!KEY_NAMES.includes(name)) throw new Error('Unknown key name.');
    const raw = this.#read();
    delete raw[name];
    this.#write(raw);
  }
}
