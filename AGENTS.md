# Pi Studio - Development Notes

## Quick Start

```bash
npm run dev   # port 10141 (see package.json; the old doc said 30141 — a stale `next start` once ran there)
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  agent/running/events/route.ts   GET SSE stream of currently-running session ids
  auth/all-providers/route.ts     GET API-key provider list
  auth/api-key/[provider]/route.ts GET/POST/DELETE provider API key status/storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth provider list
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd-YYYYMMDD
  open-file/route.ts              GET/POST right-panel active file marker (agent default target)
  browser/route.ts                GET/POST/DELETE web-preview marker (agent pushes a page to the panel)
  browser/proxy/route.ts          GET/POST server-side fetch+rewrite proxy for the sandboxed iframe
  browser/control/[...path]/route.ts GET/POST streamed pass-through to the browser-use sidecar (127.0.0.1:17865): /open /url /content /screenshot /screencast (SSE live frames) /input (CDP click/type/scroll/key) /evaluate
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  worktrees/route.ts              GET/POST/DELETE git worktrees
  univer/view/route.ts            GET .univer → xlsx bytes for the viewer (headCommit-validated cache)
  univer/export/route.ts          GET export .univer → .xlsx/.csv download
  univer/writeback/route.ts       POST write .univer back over its original .xlsx
  univer/edit-commit/route.ts     POST commit online cell edits → worktree (or trunk via hidden pi-auto staging)
  univer/worktree-create/route.ts POST create draft worktree (default name u-<6随机数>)
  univer/worktree-delete/route.ts POST permanently delete a non-merged worktree (direct SQLite)
  univer/worktrees/route.ts       GET .univer worktree list + commits + userSeqs (direct SQLite read)
  univer/discard/route.ts         POST discard a worktree (CLI)

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  file-paths.ts        client/server path encoding helpers
  markdown.ts          shared markdown helpers
  npx.ts               npx runner used by skill install
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  tool-presets.ts     PRESET_NONE/DEFAULT/FULL + getPresetFromTools()
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  changed-files.ts    extractChangedFiles() — files edited/written during an assistant turn
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab (routes .xlsx → XlsxViewer, .univer → UniverFileViewer)
  XlsxViewer.tsx      Univer sheets viewer — core preset + OSS plugins (conditional formatting,
                      data validation, filter, find/replace, sort, table, hyperlink, note,
                      thread comment; zh-CN locales merged) + filter worker preset. SheetJS CE
                      drops conditionalFormatting/dataValidations/autoFilter on read, so the viewer
                      unzips the xlsx with fflate and translates the sheet XML into Univer workbook
                      `resources` payloads (see parseXlsxAdvancedFeatures / buildAdvancedResources)
  ChangedFilesCard.tsx changed-files summary card under assistant messages
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
```

---

## Key Design Decisions & Traps

### Right-panel open-file marker (agent convention)
- `AppShell` reports the currently active file tab to `/api/open-file` whenever it changes (deduped per path via a ref; fires only on change). The route persists `{ filePath, updatedAt }` to pi-web's own data dir (default `<project>/pi-web-uploads/.internal/pi-web-open-file.json`; see `lib/storage-config.ts` — the location is user-configurable, no longer `~/.pi/agent`). Atomic tmp+rename write.
- **Convention: when the user asks to edit "the table" / a spreadsheet without naming a file, default to the file recorded in that marker** (the one open in the right viewer). Read it with `GET /api/open-file` or directly from the marker file under pi-web's data dir (default `<project>/pi-web-uploads/.internal/pi-web-open-file.json`); if absent/unset, ask which file.
- **Uploads storage**: uploaded files, AI-edit .univer outputs, and pi-web's internal state all live in the configurable data dir — default `<project>/pi-web-uploads/` (created on demand; `.internal/` inside holds the open-file marker, user-edit sidecar, and univer CLI home). Location resolution: `PI_WEB_UPLOADS_DIR` env var → `.pi-web-config.json` `uploadsDir` (editable via the uploads manager UI or by hand) → project default. Legacy data from `~/.pi/agent/pi-web-*` is migrated once on server start (`instrumentation.ts` → `migrateLegacyData()`).

### Changed-files card (per-turn change summary)
- `extractChangedFiles()` (`lib/changed-files.ts`) scans assistant toolCall blocks for `edit`/`write` tools (input field is `path`, not `filePath`) and returns deduplicated `{filePath, kind}` entries.
- The card is rendered by `ChatWindow`, NOT inside `MessageView`: assistant turns are split into a collapsed `ProcessDetailsGroup` (thinking + tool calls) and a separate final-answer message. The card must sit at the **message footer level** (below the answer text, above the usage stats) or it gets hidden inside the collapsed process group.
- Changed files are gathered from **all assistant messages in the group** (`userIdx+1..endIdx`), not just the final answer message — edit/write tool calls live in the process messages.
- Per-file `+N`/`-M` diff stats are fetched lazily from `/api/git/diff` and parsed with `parseUnifiedPatch`. The fetch effect depends on a **stable `filesKey` string**, never the `files` array reference (parent re-creates it every render — depending on it causes a fetch storm that crashes the dev server).
- The card is also rendered on the streaming tail (`isLiveTail` + `streamingMessage`) so edits appear live while the agent works.

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes. Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** (Fork button on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** (Continue button / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `ChatWindow.handleAgentEvent()` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` → `toolNames[]`). For existing sessions, the active preset is inferred on mount via `get_tools` → `getPresetFromTools()`. When tools are fully disabled (`toolNames = []`), `rpc-manager.ts` passes an empty tool allow-list and forces `agent.state.systemPrompt = ""` after startup/reload/resource discovery.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction, then `lib/startup-preferences.ts` persists their effective values without replaying `set_model`/`set_thinking_level`; implicit `enabledModels` fallbacks and thinking pins are not persisted.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-studio and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.

### Univer viewer in-place sync (`.univer` files)
- **One Univer instance per file.** `XlsxViewer` keeps the instance alive across scope switches; a scope change (branch switch / external `univer execute` commit) is **diff-applied in place** (cell v/t/f/s via `FRange.setValue`, merges via `merge()` / `sheet.command.remove-worksheet-merge`), not a full dispose+recreate. Only structural changes (sheet set/names/dimensions, CF/validation/filter resources, or >8000 changed cells) fall back to a recreate.
- **Parsed-scope cache** (`loadScopeData`/`warmScopeData` in XlsxViewer.tsx): each scope's parsed workbook is cached keyed by `scopeKey = <file>::wt:<id>::<headCommit>` (or `::trunk::<mtime>`). `UniverFileViewer`'s poll advances an `ackRevRef` only when the **viewed** scope's own content changed externally — commits to other worktrees, status changes, and the user's own auto-saves (`ownSaveRef`: worktree=headCommit seq, trunk=file mtime from `/api/univer/edit-commit`) never re-sync the grid.
- `/api/univer/worktrees` returns `trunkRev` (file mtime) so the frontend can key its trunk cache; a merge invalidates it regardless of what's viewed.
- **Agent rule: never auto-merge worktrees.** Edit on a worktree, `worktree ready`, then stop — the user clicks 合并到主干 in the viewer or explicitly asks. The sheet-edit skill enforces this.
- **Verification discipline (from user feedback, 2026-08): every change must pass tsc + eslint + a headless-browser round-trip (trunk→worktree→trunk with style assertions) before being reported — never hand the user an unverified state; their browser may be running stale chunks/scope caches (see sheet-edit skill's 交付流程铁律 / 常见坑 for the full list: `setValue` merge semantics, `s:null` the only style clearer, SheetJS drops alignment, `getCellData().s` is a style id → read `wb.save().styles[id]`, daemon file locks, dev port 10141).

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, `~/pi-cwd-*`, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate`, `/api/default-cwd`, and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- **Project skills ship in `.agents/skills/`** (sheet-edit + univer-cli, see `.agents/skills/README.md`) and travel with the repo to new servers. They load only after the project is trusted (`~/.pi/agent/trust.json`, shared with the pi CLI; `/api/project-trust` POST records it, but it refuses while a session is busy and destroys cwd sessions afterwards). A project that gains `.agents/skills` flips `hasTrustRequiringProjectResources` — untrusted projects skip them entirely (`projectResourcesLoaded: false`).
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
