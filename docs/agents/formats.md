# Pi Session 文件格式

位置：`~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` 与 `messages[]` 平行 — 把每个展示消息映射回 `.jsonl` entry id，用于 fork 和 navigate_tree。

# CSS Variables（`app/globals.css`）

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

# 环境变量一览

| 变量 | 作用 |
| --- | --- |
| `PI_WEB_PORT` | Electron 内置服务固定端口（默认随机） |
| `PI_WEB_DIST_DIR` | Next 构建目录（默认 `.next`，打包用 `.next-pkg`） |
| `PI_WEB_UPLOADS_DIR` | 数据目录（上传 + 内部状态），优先级最高 |
| `PI_WEB_UPLOADS_MAX_BYTES` | 上传总量上限（默认 300MB） |
| `PI_WEB_CDP_PORT` | Electron CDP 调试端口（默认 9222，`0` 关闭） |
| `PI_WEB_HOSTNAME` / `PI_WEB_NO_OPEN` / `PI_WEB_SERVER_MODE` | Electron 内置服务绑定/不弹浏览器/dev 模式 |
| `PI_WEB_PASSWORD` / `PI_WEB_AUTH_USERNAME` | 可选 Basic Auth（用户名默认 `pi`） |
| `PI_WEB_ALLOWED_HOSTS` | 可信反代外部 hostname（逗号分隔） |
| `PI_WEB_UNIVER_HOME` | univer daemon 运行时根（默认 `<数据目录>/.internal/univer`） |
| `PI_WEB_BROWSER_BRIDGE_URL` | Electron 原生浏览器控制桥地址（主进程启动 bridge 时设置/写入标记） |
