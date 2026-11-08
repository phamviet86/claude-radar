import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore, KEY_NAMES } from '../desktop/keystore.js';
import { QuotaService } from '../lib/quotas.js';

// a fake "safeStorage": reversible, and the stored bytes never contain the plain text
const fake = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString(),
});
const KEY = 'fc-test-key-123456';

function withStore(fn, safe = fake()) {
  const root = mkdtempSync(join(tmpdir(), 'claude-radar-keys-'));
  try {
    return fn(new KeyStore({ file: join(root, 'sub', 'keys.json'), safeStorage: safe }), join(root, 'sub', 'keys.json'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('keystore: save, load and status round trip; the file never holds the plain text and is owner-only', () => {
  withStore((ks, file) => {
    assert.deepEqual(ks.status(), { FIRECRAWL_API_KEY: false, CRAWL4AI_API_KEY: false });
    assert.equal(ks.set('FIRECRAWL_API_KEY', `  ${KEY}  `), KEY); // trimmed
    assert.deepEqual(ks.status(), { FIRECRAWL_API_KEY: true, CRAWL4AI_API_KEY: false });
    assert.deepEqual(ks.load(), { FIRECRAWL_API_KEY: KEY });
    assert.equal(readFileSync(file, 'utf8').includes(KEY), false);
    assert.equal(statSync(file).mode & 0o077, 0);
    ks.remove('FIRECRAWL_API_KEY');
    assert.deepEqual(ks.load(), {});
  });
});

test('keystore: refuses unknown names, odd values, and saving without secure storage', () => {
  withStore((ks) => {
    assert.throws(() => ks.set('PATH', KEY), /Unknown/);
    assert.throws(() => ks.remove('PATH'), /Unknown/);
    for (const bad of ['', 'short', 'has space in it 12345', 'line\nbreak12345', 'x'.repeat(600)]) assert.throws(() => ks.set(KEY_NAMES[0], bad), /invalid/);
    assert.deepEqual(ks.load(), {});
  });
  withStore((ks, file) => {
    assert.throws(() => ks.set(KEY_NAMES[0], KEY), /not available/);
    assert.throws(() => readFileSync(file)); // nothing was written
  }, fake(false));
});

test('keystore: a value that cannot be decrypted is treated as not saved', () => {
  withStore((ks) => {
    ks.set(KEY_NAMES[0], KEY);
    const broken = new KeyStore({ file: ks.file, safeStorage: { ...fake(), decryptString: () => { throw new Error('keychain changed'); } } });
    assert.deepEqual(broken.load(), {});
    assert.equal(broken.status().FIRECRAWL_API_KEY, true);
  });
});

test('QuotaService.reset: forgets cached answers, and an answer on its way for the old key is not cached', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const f = async () => { calls += 1; if (calls === 1) await gate; return new Response(JSON.stringify({ data: { remainingCredits: 5, planCredits: 10 } }), { status: 200 }); };
  const q = new QuotaService({ env: { FIRECRAWL_API_KEY: KEY }, fetch: f, claude: { estimate: () => ({ fiveHour: 0, week: 0 }) }, limits: () => null });
  const first = q.get(1000); // call 1 is waiting on the gate (old key)
  await new Promise((r) => setImmediate(r));
  q.reset(); // key changed
  release();
  await first;
  await q.get(1100); // the stale answer was dropped, so this asks again
  assert.equal(calls, 2);
  await q.get(1200); // and this one is cached
  assert.equal(calls, 2);
});
