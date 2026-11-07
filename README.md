# Thread Board

A **read-only** Kanban board for Claude Code threads in **Claude desktop**: which threads need you, which are running, which are done, and what each project (folder) is up to.

No dependencies, no plugins or hooks installed into Claude, nothing written to `~/.claude` or the app's data. To reply to a thread you still open it in Claude desktop.

## Run

```bash
npm start        # http://127.0.0.1:4848  (change the port: PORT=5000 npm start)
npm test
npm run check   # type-check lib/ and server.js (JSDoc + checkJs, needs `npm install`; no build step)
```

Requires Node 22 or later. The server listens on `127.0.0.1` only and rejects other Host headers, so thread titles and summaries never leave your machine.

## Build the Mac app

There is no prebuilt download: build it yourself (about two minutes). Requirements: macOS, Node 22 or later, and the Xcode command line tools (`xcode-select --install`, for `sips` and `iconutil`).

```bash
git clone https://github.com/phamviet86/thread-board.git
cd thread-board
npm install          # installs Electron and electron-builder (dev-only; the board itself has no dependencies)
npm run build        # -> dist/mac-arm64/Thread Board.app  (dist/mac-x64 on Intel Macs)
```

Then drag `Thread Board.app` from `dist/` into Applications and open it. The build is not code-signed or notarized; because you built it on your own Mac, macOS runs it without complaint. If you copy the `.app` to another Mac (AirDrop, zip) macOS will block it: run `xattr -cr "/Applications/Thread Board.app"` once, or build it on that Mac instead.

Other scripts: `npm run app` runs the app straight from source without packaging; `npm run icons` regenerates the icons (`desktop/make-icons.mjs`).

**What you get.** Opening the app shows the board window; closing the window only hides it. A radar icon on the menu bar shows the `INPUT · RUN` counts, opens the window on click, and its right-click menu has "Launch at login" and "Quit". The app runs the same read-only server inside itself on `127.0.0.1:4858` (a free port if that one is taken), so it can run next to `npm start` (port 4848). Its own settings (filters, theme) live in `~/Library/Application Support/thread-board`; it still writes nothing to Claude's data.

**Troubleshooting.** If macOS asks whether Thread Board may access data from other apps, allow it: it reads Claude desktop's thread files. If the menu-bar counts show `×`, the built-in server could not be reached; quit and reopen the app.

## Interface

- **Sci-fi HUD style:** a sticky top bar with the radar brand mark, the **INPUT / RUN / DONE** counters (click to filter by status), a **LIVE** (or DISCONNECTED) light with the last **SYNC** time, and the theme button. Deep navy background with a faint two-level grid, a very light CRT scanline and a slow moving beam. Cards are glass panels with two chamfered corners, corner brackets and a status-colored glow; running thread cards have a light band sweeping across and a pulsing inner glow, threads that need input have a slowly "breathing" amber inner glow, and the first render plays a short power-on sequence. The detail drawer shares the same language. One font family everywhere (Chakra Petch), except code, which is JetBrains Mono. No rounded corners.
- **Light, dark and auto** theme (button in the top-right corner). Every thread can be opened by URL: `#thread=<id>`. Motion is switched off when the system asks for reduced motion.
- **Fonts** (Chakra Petch, JetBrains Mono, Be Vietnam Pro as a fallback for Vietnamese glyphs) are bundled in `public/fonts/` (SIL OFL licenses: `LICENSE-font-*`), so the page loads nothing from the network.
- **Project tags:** each folder gets its own [Lucide](https://lucide.dev) icon and color (bundled in `public/icons.js`, ISC license in `LICENSE-lucide`), stable by name and unique across the folders currently present.
- **Board:** a single grid of cards flowing left to right: **needs input first, then running, then done** (each group newest first). Each card is tinted by its status (orange, blue, green); status is also shown with its own icon, so it never relies on color alone.
  - Card header: status on the left, project icon and folder name on the right.
  - Body: title, a one-line summary (see below), and the child threads listed with their status (only while the group is not done).
  - Footer: the **Open in Claude** button, then the PINNED and "+N THREAD" chips, then the time on the right (`now`, `5m`, `2h`, `3d`). A running card shows its `PID` chip in place of the time. A card that needs input shows the full "Open in Claude" button and hides the chips to give it room; other cards show a small orange icon button.
  - A child thread lives inside its parent's card. The card's status is the worst of the whole group (needs input > running > done), so a parent is only "done" when all children are. Cards that change status slide to their new position and flash briefly.
- **Time range** (a Today / 3 days toggle, default Today; click the selected one again to select neither, which shows all): applies only to finished threads. Threads that need input or are running always show. With many finished threads, the first 24 are shown plus a "Show more" button.
- **Counters in the top bar** (INPUT, RUN, DONE) double as status filters: click one to see only that status, click again to clear. A counter "lights up" (glowing border and bright text) when it has something to show: INPUT and RUN light up when above zero, DONE only when there is nothing to do.
- **Filter chips:** Pinned and one chip per project folder, all toggles: click to filter, click again to clear (nothing selected shows every thread).
- **Cards are ordered by time**, newest first. Pinned threads (starred in Claude desktop) are not moved to the top; they only carry the PINNED chip.
- Refreshes every 5 seconds. Threads archived in Claude desktop are hidden.
- The card summary line: for a stopped thread, the automatic summary Claude desktop writes after each turn; for a running thread or one without a summary, the latest message (a trimmed chat excerpt, not a summary; your message if Claude has not answered yet), because the summary only exists once a turn ends. If a child thread decides the group's status, its line is shown with the child's name.

## Opening a thread in Claude desktop

Cards that need input have a full orange **Open in Claude** button (it opens the exact thread that is waiting for you). Other cards have a small orange icon button. The detail drawer has a matching button for the thread being viewed. The button opens `claude://code/continue?session=<id>` (an id like `local_…`): Claude desktop looks up the unarchived thread with that id and opens it. (The `needs-input` link only opens threads the app itself considers waiting, so a thread that merely stopped to ask would land in a new session; that is why it is not used.) For a group with child threads the button opens the thread that is waiting for you.

Note: this link is not officially documented (only `claude://code/new` is; `continue` was found in the app's code) so it may change between versions. Archived threads cannot be opened. Verified on Claude desktop 4.23118.0 (macOS). If the button ever opens a new session instead of the thread, a newer app version may have changed the link. The browser asks once whether to open Claude. If nothing happens, open the thread from Claude desktop's own list; the page never sends or writes anything to Claude.

## Timeline

Click a card (or a child thread) to open the detail drawer. For a group with several threads, pick the thread to inspect at the top. The timeline lists, newest first: each turn with your message, the tools used (name and count only), Claude's final answer and the run time, plus the "Created" milestones for the thread and its children. At most the latest 60 turns are shown.

The timeline and the latest-message line are the two features that read **conversation content** (`~/.claude/projects/*/<id>.jsonl`). The timeline is read only when you open a thread; the latest-message line reads only the tail of each file (1 MB, growing up to 32 MB if that part holds only tool results) and is cached by modification time. Text is trimmed (240 characters for the card line; at most 700 and 1600 characters for your message and the answer in the timeline, rendered as markdown); Claude's thinking and tool contents or results are never kept or sent. The server only listens on `127.0.0.1`.

## Data and how status is derived

| Source | Used for |
| --- | --- |
| `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json` | Every thread: title, folder, parent thread (`spawnedFrom`), pinned (`isStarred`), archived, end-of-turn summary (`postTurnSummary`) |
| `~/.claude/sessions/<pid>.json` | Running threads: `status` is `busy`, `idle`, `waiting` or `shell` |
| `~/.claude/projects/*/<cliSessionId>.jsonl` | The latest message on the card (tail read) and the timeline (when you open a thread) |

Order of precedence, as in `threadStatus` in `lib/model.js`:

1. A process that is `waiting` (for a permission, etc.) → **Needs input**; `busy` or `shell` → **Running** (the summary at that point belongs to the previous turn, so it is labeled "Previous turn").
2. End-of-turn summary: `blocked` or `review_ready` → **Needs input**; `completed` → **Done**.
3. No summary: process alive → **Running**; process gone → **Done**, shown as "No summary yet".

A thread is linked to its process by `hostSessionId` (then the CLI `sessionId`). A child whose parent is archived or missing stands on its own. A project's folder is `originCwd` (worktrees fold into the main project).

## Known limits

- "Needs input" and "Done" rely on a summary Claude writes itself after each turn, so they are sometimes wrong; the drawer says so.
- This is Claude's internal format and may change between versions. When it cannot be read, the page shows a warning instead of failing.
- Only threads on this machine are visible (no SSH or cloud sessions). Multiple Claude configurations are not supported (`CLAUDE_CONFIG_DIR` takes a single directory).
- Claude's summaries are sometimes truncated or out of step with the last message; the latest message can be long or just "Done.".

## Environment variables

| Variable | Effect |
| --- | --- |
| `PORT` | Port (default 4848) |
| `THREAD_BOARD_DESKTOP` | Claude desktop's thread directory; `off` to disable |
| `CLAUDE_CONFIG_DIR` | Claude Code config directory (default `~/.claude`) |
