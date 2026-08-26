# 参考项目调研基线（组长初步提取）

> 组长已 clone 两参考仓库原始码，提取关键特征作为下游角色核对照。角色可在此基线基础上核实、补充或纠正。
> 我的项目（比对对象）= `@aacs111/pi-studio`（v0.8.6），Multi-Agent 实现在 `lib/team/**`（Event Sourcing 运行时 + 工作流网关 + Team Chat）。

## 1️⃣ MetaGPTTest（`https://github.com/NanGePlus/MetaGPTTest`）
- 一份**教程/测试工程**：讲解 MetaGPT 框架（B站/YouTube 视频配套 + python 示例 `nangeAGICode/*.py`）。
- 核心哲学：**SOP(Team) = 智能体社会的标准作业程序**。
  - `智能体 = LLM + 观察 + 思考 + 行动 + 记忆`
  - `多智能体 = 智能体 + 环境 + SOP + 通信 + 经济`
- 预设 8 种 Role（含代码示例取证）：Role / Architect / ProjectManager / ProductManager / Engineer / QaEngineer / Searcher。
- Role 关键属性：`name` `profile` `goal` `constraints`；`set_actions([...])` 绑定动作；`self._watch({WritePRD})` 订阅上游产出。
- **消息池/发布-订阅模式**：每个角色 watch 上游输出、publish 自己的输出给下游（`publish_message` 机制，共享环境 Environment）。
- 经济（Economy）：价值交换/资源分配（token 记账）。

## 2️⃣ OpenHarness（`https://github.com/HKUDS/OpenHarness/tree/main`）
Python 实现的「Agent Harness」— 套在 LLM 外让其可用的完整基建：工具、技能、记忆、权限、多 agent 协调。
- **Harness = Tools + Knowledge + Observation + Action + Permissions**。
- 44 个 tools（File/Shell/Search/Web/MCP，`src/openharness/tools/`）、按需 skill 加载（`.md`，`anthropics/skills` 兼容）、插件生态。
- **多级权限模式 + 路径/命令规则 + PreToolUse/PostToolUse hooks**（`src/openharness/permissions/`、`src/openharness/hooks/`）。
- **Swarm 多 agent 协调**（`src/openharness/swarm/`）：
  - `worktree.py`：**一个给 agent 的 Git worktree 隔离**（每 agent 独立 worktree + 分支 + 符号链接公共依赖目录）——**对标 Pi 的 P2-1（未实现）**。
  - `permission_sync.py`：**leader-worker 权限审批同步协议**（pending/{id}.json → resolved/，mailbox 亦可）——**worker 请求权限 → leader 批准/驳回** 的跨 agent 审批，比对 Pi 的 P1-2 审批闸门（已有但方向是人→UI）。
  - `team_lifecycle.py`：**持久化 Team 生命周期**（`~/.openharness/teams/<name>/team.json`，JSON 落盘，映射 TS teamHelpers API）+ `AllowedPath` 共享可写路径。
  - `mailbox.py`：**teammate 邮箱**（agent 间消息投递）。
- **共享团队记忆库**（`src/openharness/memory/team.py`）：项目级 `team/MEMORY.md`，**写入带 secret 扫描防护**（私钥/AWS/GitHub/OpenAI/Anthropic key 正则拦截）+ 路径穿越/符号链接逃逸校验。
- 其他基建：**Auto-Compaction**（跨长会话保留任务状态与频道日志）、CLI channels（Feishu/Slack/Telegram/Discord/**DingTalk**）、并行工具执行、dry-run 安全预览、多 provider 兼容（Claude/OpenAI/Copilot/Codex/Kimi/GLM/MiniMax/NVIDIA）。

## 3️⃣ 已确认 Pi Studio（lib/team）现状（供核对基准）
- ✅ 已有：Event Sourcing 运行时、工作流网关、parallel 真并发（P0-3）、autoSolo（P0-1）、verdictGuard 结构化裁决（P1-1）、审批闸门 waiting_approval（P1-2）、expected_output（P0-4）、共享任务黑板。
- ❌ 明确缺（见 memory 待办）：**P2-1 worktree 隔离未实现**（`types.ts:25` 注释 "Phase 2"）、**P2-2 跨 run 记忆未实现**、P2-3 执行回放 UI 半成品（已完成 run 不可回看执行分解）、WorkflowEditor 无 i18n。

## ⏭ 交接提示
研究员负责：把两参考项目能力做成详细「功能矩阵」，逐项标注 Pi **已有/缺失/部分**。测试角色负责：针对「缺失」项在 `lib/team/**` + `components/**` 源码逐行核实真伪（防"口头有实现"）。组长最后汇总成面向用户的「缺陷与不足清单 + 已覆盖/待补」最终结论。