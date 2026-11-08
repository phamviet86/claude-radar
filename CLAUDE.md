# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Claude Radar: a **read-only** Kanban board of Claude Code threads from Claude desktop (needs input / running / done). It never writes to `~/.claude` or Claude desktop's data and installs no hooks or plugins. By default it makes no outbound calls and reads no keys; the single opt-in exception is the Quotas panel (below). The server has zero runtime dependencies (Node ≥ 22, ESM); Electron, electron-builder, TypeScript and `@types/node` are dev-only. `README.md` documents the user-facing behavior in detail.

## Commands

```bash
npm start                  # board on http://127.0.0.1:4848 (PORT=… to change)
npm run dev                # same, node --watch
npm run demo               # board over made-up data on :4868 (no real Claude data read)
npm test                   # node --test test/
node --test test/model.test.js                       # a single test file
node --test --test-name-pattern="<pattern>" test/    # a single test by name
npm run check              # tsc, type-checks server.js + lib/ (JSDoc + checkJs, strict, no build)
npm run app                # Electron wrapper from source
npm run build              # macOS .app into dist/ (needs Xcode CLI tools for sips/iconutil)
npm run screenshots        # regenerate docs/*.png from demo data (needs Electron)
```

There is no linter or bundler. The frontend in `public/` is plain browser JS/CSS, served as-is.

## Architecture

Data flows disk → `lib/read.js` → `lib/model.js` → `server.js` → `public/app.js`:

- **`lib/read.js`** (`SessionReader`): reads Claude's internal files — desktop thread JSON (`~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json`), the process registry (`~/.claude/sessions/<pid>.json`), and conversation transcripts (`~/.claude/projects/*/<cliSessionId>.jsonl`). Caches by file mtime and returns `warnings` instead of throwing when the (undocumented, version-fragile) formats don't match.
- **`lib/model.js`**: pure functions, no I/O. `threadStatus` implements the status precedence (live process `waiting`/`busy` beats the post-turn summary, which beats process-gone fallback); `buildBoard` groups child threads (`spawnedFrom`) under parents (group status = worst of members), folds worktrees into the project via `originCwd`, and buckets by day. Keep it pure so tests can feed it fixtures.
- **`lib/timeline.js`**: parses a transcript into the per-turn work list and the "latest message" line. Reads the file tail only for the card line; full parse only when a thread's drawer is opened. Thinking and tool contents/results are deliberately never kept or sent.
- **`lib/quotas.js` / `lib/usage.js`** (opt-in Quotas): `QuotaService` returns cards for Claude (local token estimate from transcripts, `ClaudeUsage`, no network), Firecrawl (`GET /v2/team/credit-usage`, only when `FIRECRAWL_API_KEY` is set), and fixed "unavailable" cards for Crawl4AI (no REST balance) and Perplexity (no API). Invariants: key only from env, never logged/returned/stored (errors are fixed phrases + `redact`), 5-min cache incl. errors, no retries, one in-flight call, 8 s timeout, only the vendor's HTTPS host, never a spend-changing endpoint. `fetch` and the Claude estimator are injectable: tests and `demo/` (`demoQuotas()`) must use mocks and never a real key or live call. `createBoardServer(reader, now, quotas)` takes the service as its third argument; the UI is `public/quotas.js` (textContent only).
- **`server.js`**: `createBoardServer(reader, now)` is exported (injectable reader/clock for tests and for the Electron app). Endpoints: `/api/board`, `/api/timeline?id=local_…`, `/api/quotas` (cached only), static files from `public/`. Security-relevant: binds `127.0.0.1` only, rejects non-loopback `Host` headers (DNS-rebinding guard), GET/HEAD only, and timeline accepts only IDs of known threads (the transcript path is always resolved server-side, never from the request). Preserve these.
- **`desktop/main.js`**: Electron shell that runs `createBoardServer()` in-process (port 4858, falls back to a free port), plus tray counts and a hide-on-close window. Packaged files are whitelisted in `package.json` → `build.files`; new runtime files must be added there.
- **`public/`**: vanilla JS single page (`app.js`) polling `/api/board` every 2s; fonts and Lucide icons are bundled (no network). Dark-only HUD styling in `style.css`.
- **`demo/`**: `data.mjs` generates fake thread files/registry/transcripts in a temp dir and points the reader at it via env vars; used by `npm run demo` and the screenshot script. Any README screenshot must come from this made-up data, never real threads.

## Conventions

- Types are JSDoc only (`checkJs`); `tsconfig.json` covers `server.js` and `lib/**` but not `public/` or `desktop/`.
- Env vars: `PORT`, `CLAUDE_RADAR_DESKTOP` (thread dir, `off` disables), `CLAUDE_CONFIG_DIR` (single Claude config dir).
- The "Open in Claude" button uses the undocumented `claude://code/continue?session=<id>` link; don't switch to `needs-input` (see README).
