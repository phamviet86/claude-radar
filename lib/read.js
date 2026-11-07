// Đọc đĩa, chỉ đọc. Hai nguồn:
// - Claude desktop: <dữ liệu app>/claude-code-sessions/<tài khoản>/<tổ chức>/local_*.json (mọi thread);
// - sổ đăng ký của Claude Code: ~/.claude/sessions/<pid>.json (chỉ các tiến trình đang chạy).
// Không ghi gì, và không bao giờ mở nội dung hội thoại (~/.claude/projects/*.jsonl). Định dạng là nội bộ của Claude và có
// thể đổi: lỗi nào cũng thành "không có dữ liệu" kèm một cảnh báo, phần còn lại của bảng vẫn chạy.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseDesktopSession, parseRegistryEntry } from './model.js';
import { latestMessage, parseTranscript } from './timeline.js';

const TRANSCRIPT_MAX_BYTES = 100 * 1024 * 1024;
/**
 * Phần cuối của tệp hội thoại được đọc để lấy tin nhắn mới nhất: thử 1 MB trước; nếu cả đoạn đó chỉ toàn kết quả công cụ hay
 * ảnh chụp màn hình (không có tin nhắn nào) thì mở rộng dần, tối đa 32 MB.
 */
const TAIL_STEPS = [1, 8, 32].map((m) => m * 1024 * 1024);

const HOST_FILE = /^local_[\w-]+\.json$/;

/** Thư mục thread của app desktop (null = tắt bằng THREAD_BOARD_DESKTOP=off). */
export function desktopSessionsDir(env = process.env, platform = process.platform, home = homedir()) {
  const o = env.THREAD_BOARD_DESKTOP?.trim();
  if (o) return /^(off|0|false)$/i.test(o) ? null : o;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
  if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'Claude', 'claude-code-sessions') : null;
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude-code-sessions');
}

/** Thư mục sổ đăng ký tiến trình của Claude Code. */
export function registryDir(env = process.env, home = homedir()) {
  return join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude'), 'sessions');
}

function subdirs(path) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(path, d.name));
  } catch {
    return [];
  }
}

/** Tiến trình còn tồn tại không? (sổ của tiến trình đã chết không tính là "đang chạy"). */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

export class SessionReader {
  /**
   * @param {{desktopDir?: string|null, registryDir?: string, isAlive?: (pid:number)=>boolean}} [opts]
   */
  constructor(opts = {}) {
    this.desktopDir = opts.desktopDir === undefined ? desktopSessionsDir() : opts.desktopDir;
    this.registryDir = opts.registryDir ?? registryDir();
    this.isAlive = opts.isAlive ?? pidAlive;
    this.projectsDir = opts.projectsDir ?? join(this.registryDir, '..', 'projects');
    this.cache = new Map();
    this.timelines = new Map();
    this.latests = new Map();
    this.paths = new Map();
  }

  /** Đọc một tệp JSON, có cache theo ngày sửa và kích thước. */
  #cached(file, parse) {
    const st = statSync(file);
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = parse(readFileSync(file, 'utf8'));
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  /** Đường dẫn tệp hội thoại của một thread (tìm trong mọi thư mục dự án, có nhớ lại). */
  #transcript(cliId) {
    if (!cliId || !/^[\w-]+$/.test(cliId)) return undefined;
    const known = this.paths.get(cliId);
    if (known) {
      try {
        return { file: known, st: statSync(known) };
      } catch {
        this.paths.delete(cliId);
      }
    }
    for (const dir of subdirs(this.projectsDir)) {
      const file = join(dir, `${cliId}.jsonl`);
      try {
        const st = statSync(file);
        this.paths.set(cliId, file);
        return { file, st };
      } catch {
        /* không ở thư mục này */
      }
    }
    return undefined;
  }

  /** Tin nhắn mới nhất (của bạn hoặc của Claude), chỉ đọc phần cuối tệp; có cache theo ngày sửa và kích thước. */
  latest(cliId) {
    const t = this.#transcript(cliId);
    if (!t) return null;
    const hit = this.latests.get(t.file);
    if (hit && hit.mtimeMs === t.st.mtimeMs && hit.size === t.st.size) return hit.value;
    let value = null;
    try {
      const fd = openSync(t.file, 'r');
      try {
        for (const step of TAIL_STEPS) {
          const len = Math.min(t.st.size, step);
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, t.st.size - len);
          let text = buf.toString('utf8');
          if (t.st.size > len) text = text.slice(text.indexOf('\n') + 1); // bỏ dòng bị cắt dở ở đầu
          value = latestMessage(text);
          if (value || len >= t.st.size) break;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      value = null;
    }
    this.latests.set(t.file, { mtimeMs: t.st.mtimeMs, size: t.st.size, value });
    return value;
  }

  /** Timeline của một thread, dựng từ tệp hội thoại. Chỉ gọi khi người dùng mở thread. */
  timeline(cliId) {
    const t = this.#transcript(cliId);
    if (!t) return { found: false, turns: [], omitted: 0 };
    if (t.st.size > TRANSCRIPT_MAX_BYTES) return { found: true, tooBig: true, turns: [], omitted: 0 };
    const hit = this.timelines.get(t.file);
    if (hit && hit.mtimeMs === t.st.mtimeMs && hit.size === t.st.size) return hit.value;
    const value = { found: true, ...parseTranscript(readFileSync(t.file, 'utf8')) };
    this.timelines.set(t.file, { mtimeMs: t.st.mtimeMs, size: t.st.size, value });
    if (this.timelines.size > 20) this.timelines.delete(this.timelines.keys().next().value);
    return value;
  }

  read() {
    const warnings = [];
    const live = new Set();
    const desktop = [];
    if (!this.desktopDir) warnings.push('Reading Claude desktop is turned off (THREAD_BOARD_DESKTOP=off).');
    else if (!subdirs(this.desktopDir).length) warnings.push(`No Claude desktop threads found in ${this.desktopDir}.`);
    for (const acct of this.desktopDir ? subdirs(this.desktopDir) : []) {
      for (const org of subdirs(acct)) {
        let names = [];
        try {
          names = readdirSync(org).filter((n) => HOST_FILE.test(n));
        } catch {
          continue;
        }
        for (const n of names) {
          const file = join(org, n);
          live.add(file);
          try {
            const t = this.#cached(file, parseDesktopSession);
            if (t) desktop.push(t);
          } catch {
            /* tệp biến mất hoặc không đọc được: bỏ qua */
          }
        }
      }
    }
    const registry = [];
    let names = [];
    try {
      names = readdirSync(this.registryDir).filter((n) => n.endsWith('.json'));
    } catch {
      warnings.push(`Process registry not found in ${this.registryDir}: without it no thread shows as "Running".`);
    }
    for (const n of names) {
      const file = join(this.registryDir, n);
      live.add(file);
      try {
        const r = this.#cached(file, parseRegistryEntry);
        if (r && this.isAlive(r.pid)) registry.push(r);
      } catch {
        /* bỏ qua */
      }
    }
    for (const f of [...this.cache.keys()]) if (!live.has(f)) this.cache.delete(f);
    return { desktop, registry, warnings };
  }
}
