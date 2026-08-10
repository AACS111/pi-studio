# Pi Studio

[中文文档](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

Pi Studio is a local web workspace for the [pi coding agent](https://github.com/badlogic/pi-mono). It reads your local pi session files and provides a browser workspace for session browsing, real-time chat, model configuration, skill management, project file preview — plus two things the CLI can't do: a **full spreadsheet engine** for viewing and editing `.xlsx` / `.univer` files in place, and a **built-in browser** that the agent can drive and push pages to.

![Pi Studio shows the same pi session with structured Markdown, tool calls, and project navigation beside the CLI](https://raw.githubusercontent.com/AACS111/pi-studio/main/docs/screenshot2.png)

The same pi session in CLI and Pi Studio: structured tool calls, readable Markdown, session browsing, and cleaner results.

## Features

### Core (pi session workspace)
- **Pick work back up**: browse previous pi conversations by project without digging through terminal history or session paths.
- **Try different directions safely**: continue from an earlier message or fork a session into a separate route.
- **Work across branches**: switch Git worktrees from the sidebar so new sessions and the Explorer follow the checkout you choose.
- **Chat beside the project**: browse files on the left and preview source, docs, images, audio, and PDFs on the right while the agent works.
- **See session state clearly**: context usage, cost, compaction state, and system prompt details are visible from the top bar.
- **Configure less from the terminal**: manage models, login/API keys, model tests, plugins, and skill switches from the web UI.
- **Use the interface in your language**: switch between the supported UI languages from the top bar.

### Spreadsheet editing (built on Univer)
- **View and edit Excel files in the browser**: open `.xlsx` / `.univer` in a full Univer sheet engine — formulas, conditional formatting, data validation, filters, sort, tables, hyperlinks, notes, and thread comments all work in place.
- **AI-edit your open spreadsheet**: convert an uploaded `.xlsx` into a `.univer` draft with one click, tell the agent what to change, and review the result live in the right panel.
- **Worktree-based safety**: spreadsheet drafts live in git worktrees — create, commit, discard, or merge them back to the main trunk whenever you're ready. Nothing is ever written back automatically without your say-so.
- **Write back / export**: commit edits back over the original `.xlsx`, or export the workbook as `.xlsx` / `.csv`.

### Built-in browser (agent-driven web preview)
- **Codex-style preview panel**: a browser tab on the right that renders any website through a server-side proxy (strips `X-Frame-Options` / CSP), so pages that forbid iframes still display.
- **Agent can open pages for you**: the agent pushes URLs into the panel via the browser marker API — preview a dev server, a docs page, or a report while it works.
- **Drive it yourself**: click, type, scroll, and navigate in the panel; keyboard input is forwarded to a real headless Chrome via CDP.

### Uploads, vision, and file tooling
- **Upload manager**: attach `.xlsx` / `.univer` / images and keep them in an isolated storage area, with a storage-location picker.
- **Vision**: ask the agent to describe an image; a vision-capable model (auto-detected from your custom providers) produces the description.
- **Changed-files card**: after each agent turn, a summary card lists every edited/written file with per-file `+N`/`-M` diff stats.
- **File index**: fast project file search to point the agent and the Explorer at the right file quickly.
- **Open-file marker**: the file currently open in the right panel is exposed to the agent, so "edit the table" without naming a file just works.

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

- **Data directory**: Pi Studio reads `~/.pi/agent/sessions` by default. Set `PI_CODING_AGENT_DIR` to point at another pi agent directory.
- **Session files**: files are stored as `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
- **Model config**: the Models panel reads and writes `models.json` in the pi agent directory. Model lists and defaults come from pi's config.
- **File access**: file browsing and preview are scoped to the selected project directory and working directories that appear in sessions.
- **Upload storage**: uploaded files and internal state live in a configurable data dir — default `<project>/pi-web-uploads/` (override with `PI_WEB_UPLOADS_DIR`, `.pi-web-config.json`, or the uploads manager UI).
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
    browser/        # right-panel web preview marker + server-side proxy + CDP control
    cwd/            # browsable/validatable working directory picker
    default-cwd/    # pi default working directory lookup
    file-index/     # project file search index
    files/          # file listing, reading, preview, watching, saving
    git/            # diff and status endpoints (changed-files card)
    home/           # current user home directory
    models/         # available models, default model, thinking levels
    models-config/  # read/write models.json and test models
    open-file/      # right-panel active file marker (agent default target)
    plugins/        # package plugin management
    project-trust/  # project trust gating for .agents/skills
    sessions/       # session reads, rename, delete, context, HTML export
    skills/         # skill listing, search, install, enable/disable
    univer/         # .univer view/export/writeback + worktree lifecycle (merge/discard)
    uploads/        # isolated upload storage management
    vision/         # image description via vision-capable model
    worktrees/      # git worktree create/remove
components/
  AppShell.tsx        # main layout, URL state, top panels, file tabs
  SessionSidebar.tsx  # project selector, session tree, Explorer
  ChatWindow.tsx      # messages, SSE, image drag/drop, minimap
  ChatInput.tsx       # input bar, model/tools/thinking/compact/slash controls
  MessageView.tsx     # message, thinking, tool call/result rendering
  ModelsConfig.tsx    # model and auth configuration panel
  PluginsConfig.tsx   # installed package plugins panel
  SkillsConfig.tsx    # skill management panel
  FileExplorer.tsx    # file tree
  FileViewer.tsx      # source, diff, image, audio, PDF, DOCX preview
  XlsxViewer.tsx      # Univer sheet engine (lazy-loaded) for .xlsx
  UniverFileViewer.tsx# in-place diff-applied viewer for .univer worktrees
  WebViewer.tsx       # right-panel browser tab (agent-driven web preview)
  UploadsManager.tsx  # upload storage panel
lib/
  rpc-manager.ts      # AgentSessionWrapper lifecycle and global registry
  session-reader.ts   # parses .jsonl session files and branch contexts
  normalize.ts        # normalizes toolCall field names
  file-access.ts      # file read safety boundary
  file-paths.ts       # path encoding and relative path helpers
  storage-config.ts   # uploads/data directory resolution
  univer-cli.ts       # univer daemon + CLI integration
  browser-proxy.ts    # server-side web preview proxy helpers
hooks/
  useAgentSession.ts  # session loading, command sending, SSE state machine
  useAudio.ts         # completion sound
  useDragDrop.ts      # image drag/drop
  useTheme.ts         # theme switching
bin/
  pi-studio.js        # npm CLI entrypoint
```

## License

MIT — see [LICENSE](./LICENSE).
