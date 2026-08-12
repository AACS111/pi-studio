# Pi Studio

[中文文档](./README.zh-CN.md)

Pi Studio is a local web workspace for the [pi coding agent](https://github.com/badlogic/pi-mono), forked from [agegr/pi-web](https://github.com/agegr/pi-web). It reads your local pi session files and provides a browser workspace for session browsing, real-time chat, model configuration, skill management, and project file preview — plus things the CLI alone can't do: a **full spreadsheet engine** for viewing and editing `.xlsx` / `.univer` files in place, and a **built-in browser** the agent can drive and push pages to.

On top of the original pi-web UI, Pi Studio adds:

- **Electron desktop app** — a packaged desktop shell whose right-side browser is a pool of native `WebContentsView`s, controlled through a semantic HTTP bridge (Semantic Browser V2)
- **Deep Univer integration** — view, online-edit, git-worktree drafts, write back to the original `.xlsx`, encrypted-file support (WPS KET bridge), and post-import compression
- **Security hardening** — Origin/Host validation, optional HTTP Basic Auth, path-traversal guards, an allow-list for file access, and sanitized upload names
- **browser-use sidecar** — automatic headless-Chrome fallback for the right panel when not running in Electron
- **And more**: upload manager, PWA, i18n (en/zh-CN), Git worktrees, project trust, skill install/update/lock, model catalog/discovery/test, vision describe, chat lazy-loading

![Pi Studio shows the same pi session with structured Markdown, tool calls, and project navigation beside the CLI](https://raw.githubusercontent.com/AACS111/pi-studio/main/docs/screenshot2.png)

The same pi session in CLI and Pi Studio: structured tool calls, readable Markdown, session browsing, and cleaner results.

## Features

### Two run modes

**Browser mode** — the original pi-web web experience. The right-side browser renders through a server-side sandboxed-iframe proxy (`/api/browser/proxy`) that strips `X-Frame-Options` / CSP, so pages that forbid iframes still display.

**Electron desktop mode** — a packaged desktop app (Windows). The built-in Next service runs as a child process on a random `127.0.0.1` port; the right-side browser is a pool of native `WebContentsView`s (one per tab, only one visible) with:

- **Semantic Browser V2 control bridge** (`electron/bridge.cjs`): `/snapshot` returns `ref/role/name/value` per element; a scored locator (exact text > aria > placeholder > testid > contains) resolves elements, with ambiguous matches returning `409` + candidates.
- **Batch execution**: `/execute` runs multi-step actions (fill / select / click / check / wait / assert) in a single JS context.
- **Advanced actions**: native `<select>` plus Ant Design / Element Plus combobox support, conditional waits and assertions.
- **CDP remote debugging** on `127.0.0.1:9222` by default (`PI_WEB_CDP_PORT` to change, `0` to disable).

In browser mode the same control API falls back to a **browser-use sidecar** (FastAPI on `127.0.0.1:17865`, automatically started and failure-tolerant), so agent-driven browsing works everywhere.

### Spreadsheet editing (built on Univer)

- **View and edit Excel files in the browser**: open `.xlsx` / `.univer` in a full Univer sheet engine — formulas, conditional formatting, data validation, filters, sort, tables, hyperlinks, notes, and thread comments all work in place.
- **AI-edit your open spreadsheet**: convert an uploaded `.xlsx` into a `.univer` draft with one click, tell the agent what to change, and review the result live in the right panel.
- **Worktree-based safety**: spreadsheet drafts live in git worktrees — create, commit, discard, or merge them back to the main trunk whenever you're ready. Nothing is ever written back automatically without your say-so.
- **Write back / export**: commit edits back over the original `.xlsx` (rebuilt via SheetJS), or export the workbook as `.xlsx` / `.csv`.
- **Encrypted workbooks**: standard OOXML / WPS TSD / WPS structure-encrypted `.xlsx` are decrypted through the WPS KET COM bridge and cached safely.
- **Import compression**: a 34 MB imported `.univer` is typically reduced to ~10 MB.

### Chat & session workspace (core)

- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Changed-files card**: after each agent turn, a summary card lists every edited/written file with per-file `+N`/`-M` diff stats.
- **Configure less from the terminal**: manage models, login/API keys, model tests, plugins, and skill switches from the web UI.
- **Use the interface in your language**: switch between English and Chinese (zh-CN) from the top bar; other languages are easy to add via the i18n registry.

### Uploads, vision, and file tooling

- **Upload manager**: attach `.xlsx` / `.univer` / images into an isolated storage area with a storage-location picker and capacity stats.
- **Vision**: ask the agent to describe an image; a vision-capable model (auto-detected from your custom providers) produces the description.
- **File index**: fast project file search to point the agent and the Explorer at the right file quickly.
- **Open-file marker**: the file currently open in the right panel is exposed to the agent, so "edit the table" without naming a file just works.
- **PWA**: install Pi Studio as an offline-capable app on mobile and desktop.

### Security

- **Origin/Host validation** on every API request (CSRF protection); non-API pages validate the Host.
- **Optional HTTP Basic Auth**: set `PI_WEB_PASSWORD` to protect the web interface and all API endpoints (username is always `pi`, compared with a timing-safe hash).
- **Path-traversal guards** and a strict allow-list for `/api/files` (session cwds, resolved project roots, `~/pi-cwd-*`, and explicitly allowed roots).
- **Sanitized upload names**, symlink-safe bash-output reads, and a bounded upload quota (default 300 MB with LRU cleanup).
- **Project trust gating**: project-level skills (`.agents/skills`) load only after the project is trusted (`~/.pi/agent/trust.json`, shared with the pi CLI).

## Quick Start

Pi Studio requires Node.js 22.19.0 or newer. Check your version with `node --version`.

**Run without installing:**

```bash
npx @aacs111/pi-studio@latest
```

**Or install globally:**

```bash
npm install -g @aacs111/pi-studio
pi-studio
```

Then open [http://127.0.0.1:30141](http://127.0.0.1:30141). The CLI will try to open the browser automatically after the server is ready. Pi Studio listens on `127.0.0.1` by default.

**Options:**

```bash
pi-studio --port 8080              # custom port
pi-studio --hostname 0.0.0.0       # expose on a trusted network
pi-studio -p 8080 -H 0.0.0.0       # combine options
pi-studio --no-open                # do not open the browser automatically

PORT=8080 pi-studio                # environment variable is also supported
PI_WEB_HOSTNAME=0.0.0.0 pi-studio  # explicit network exposure
PI_WEB_ALLOWED_HOSTS=pi-studio.internal pi-studio  # allow an exact proxy/custom hostname
PI_WEB_PASSWORD='a-long-random-password' pi-studio  # require Basic Auth (username: pi)
PI_WEB_NO_OPEN=1 pi-studio         # useful when running as a background service
```

Set `PI_WEB_PASSWORD` to protect the web interface and every API endpoint with HTTP Basic Auth. The username is always `pi`. Leaving the variable unset or empty disables authentication.

Pi Studio can invoke a high-privilege agent. Basic Auth does not encrypt the password in transit, so do not expose plain HTTP to the internet. Use HTTPS through a trusted reverse proxy or a trusted VPN for remote access.
API requests accept loopback names, IP literals, the selected bind hostname, and exact comma-separated names in `PI_WEB_ALLOWED_HOSTS`. Configure that variable when a trusted reverse proxy uses a different external hostname.

## Desktop App (Electron)

Pi Studio ships as a Windows desktop application with the right-side browser backed by native `WebContentsView`s (see [Features](#features)). Build it from source:

```bash
npm run pack:dir       # unpacked folder under release/ (fastest for verification)
npm run pack:portable  # single-file portable .exe
npm run pack:nsis      # installer .exe
npm run pack:msi       # .msi
npm run pack           # installer + portable
```

Packaging uses a separate build directory (`.next-pkg`) so it never interferes with `npm run dev`. The packaged app runs the built-in Next service on a random localhost port, keeps its data in `%APPDATA%/Pi Studio/pi-web-uploads` (Program Files is not writable), and tears down the whole child-process tree on exit.

## HTTP Proxy

Pi Studio reads the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables for server-side model and API requests.

On macOS or Linux:

```bash
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
npx @aacs111/pi-studio@latest
```

On Windows PowerShell:

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @aacs111/pi-studio@latest
```

## Notes

- **Data directory**: uploads and internal state live in a configurable data dir — default `<project>/pi-web-uploads/` (override with `PI_WEB_UPLOADS_DIR`, `.pi-web-config.json`, or the uploads manager UI). Legacy data from `~/.pi/agent/pi-web-*` is migrated once on startup.
- **Session files**: Pi Studio reads `~/.pi/agent/sessions` by default. Files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory, and merges provider auth from pi's `AuthStorage`.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Git worktrees**: see [Worktrees in Pi Studio](./docs/worktrees.md) for when the switcher appears, how new worktrees are created, and what removal does.
- **Forks vs in-session branches**: Fork creates a new `.jsonl` file. "Edit from here" creates another branch inside the same session file.
- **Internationalization**: see [Internationalization](./docs/i18n.md) for using translations and adding languages or UI text.

## Development

```bash
npm install
npm run dev
```

The local dev server runs at [http://127.0.0.1:10141](http://127.0.0.1:10141).

Common checks:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
```

Avoid running `next build` / `npm run build` during local development. It writes to `.next/` and can interfere with the dev server; leave builds for release work.

## Project Structure

```text
app/
  api/
    agent/          # creates/drives AgentSession and exposes SSE events
    auth/           # OAuth and API key management
    browser/        # right-panel web preview marker + server-side proxy + control bridge
    cwd/            # browsable/validatable working directory picker
    default-cwd/    # pi default working directory lookup
    file-index/     # project file search index
    files/          # file listing, reading, preview, watching, saving
    git/            # diff and status endpoints (changed-files card)
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json, model catalog/discovery/test
    open-file/      # right-panel active file marker (agent default target)
    plugins/        # package plugin management
    project-trust/  # project trust gating for .agents/skills
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, check/update, enable/disable
    univer/         # .univer view/export/writeback + worktree lifecycle (merge/discard)
    uploads/        # isolated upload storage management
    vision/         # image description via vision-capable model
    worktrees/      # git worktree create/remove
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap, lazy loading
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  PluginsConfig.tsx   # installed package plugins panel
  SkillsConfig.tsx    # skill management panel
  ProjectTrustDialog.tsx # project trust confirmation dialog
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
  XlsxViewer.tsx      # Univer sheet engine (lazy-loaded) for .xlsx
  UniverFileViewer.tsx# in-place diff-applied viewer for .univer worktrees
  WebViewer.tsx       # right-panel browser tab (WebContentsView / sidecar)
  UploadsManager.tsx  # upload storage panel
  PwaRegistration.tsx # Service Worker registration
lib/
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  storage-config.ts   # uploads/data directory resolution
  univer-cli.ts       # univer daemon + CLI integration
  univer-db.ts        # direct SQLite reads for worktree/commit state
  ket-bridge.ts       # WPS KET COM decryption bridge for encrypted .xlsx
  browser-proxy.ts    # server-side web preview proxy helpers
  browser-sidecar.ts  # browser-use sidecar bootstrap (FastAPI fallback)
  http-dispatcher.ts  # global undici dispatcher with idle timeouts
  request-security.ts # Origin/Host validation for API requests
  web-auth.ts         # optional HTTP Basic Auth
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
  useI18n.tsx         # i18n context (en / zh-CN)
electron/
  main.cjs            # desktop main process: next child + WebContentsView pool + CDP
  bridge.cjs          # Semantic Browser V2 control bridge (HTTP)
  preload.cjs         # preload for WebContentsView pages
bin/
  pi-studio.js        # npm CLI entrypoint
scripts/
  package.mjs         # electron-builder packaging (.next-pkg, mirrors)
  dev-electron.mjs    # dev-mode Electron shell
```

## License

MIT — see [LICENSE](./LICENSE). Built on [pi-web](https://github.com/agegr/pi-web) by [agegr](https://github.com/agegr), which in turn builds on [pi](https://github.com/badlogic/pi) by [badlogic](https://github.com/badlogic).
