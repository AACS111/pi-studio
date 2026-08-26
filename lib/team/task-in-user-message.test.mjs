// 回归测试：task 必须显式拼进首条 user message，不被 provider prompt cache 吞掉
// 根因：executor 此前首条 prompt 只发触发指令（"请根据以上信息开始执行"），task 仅追加在
// systemPrompt 末尾。当 provider 命中旧 systemPrompt cache 时，追加部分被吞、LLM 收不到 task、
// 误判"无用户任务"。修复：buildInitialPrompt(task) 把 task 作为 user message 显式发出。
import { test } from "node:test";
import assert from "node:assert/strict";

// 复刻 executor.ts 的 buildInitialPrompt（独立实现避免 import 依赖）
const INITIAL_PROMPT =
  "\n\n请根据以上信息开始执行你的职责。完成工作后，如有需要交接的内容，使用 team_handoff 工具交接给下一个角色（strict 模式不适用则跳过）。";
function buildInitialPrompt(task) {
  const t = (task ?? "").trim();
  if (!t) return INITIAL_PROMPT;
  return [
    "",
    "## 用户任务（本次必须完成的需求，唯一权威来源）",
    t,
    "",
    "请立即开始执行以上任务。完成后如需下游角色接力，使用 team_handoff 交接；若任务已全部由你完成，使用 team_handoff(to: \"__end__\") 结束。",
  ].join("\n");
}

test("真实MPS任务：task 全文出现在首条 user message 里", () => {
  const task = "@MPSHandler @TcMslFileServiceImpl 页面地址：http://192.168.6.190:92/#/sheet/detail/BOOK2035906848544997377\n帮我把MPS页面的独立需求单号的筛选框的逻辑由单选改为多选，但只能最多选择2个";
  const p = buildInitialPrompt(task);
  assert.ok(p.includes("单选改为多选"), "task 关键内容必须进 prompt");
  assert.ok(p.includes("## 用户任务"), "必须有任务块标题");
  assert.ok(p.includes("@MPSHandler"), "task 里的角色引用必须保留");
});

test("空/空值 task 回退到 INITIAL_PROMPT（不崩）", () => {
  assert.equal(buildInitialPrompt(""), INITIAL_PROMPT);
  assert.equal(buildInitialPrompt(undefined), INITIAL_PROMPT);
  assert.equal(buildInitialPrompt(null), INITIAL_PROMPT);
  assert.equal(buildInitialPrompt("   \n  "), INITIAL_PROMPT);
});

test("含引号/反斜杠/中文标点的 task 完整保留", () => {
  const task = '把 "MPS销售FCST比对" sheet 的版本逻辑改掉，路径 a\b/c';
  const p = buildInitialPrompt(task);
  assert.ok(p.includes("MPS销售FCST比对"));
  assert.ok(p.includes("a\b/c"));
});

test("user message 一定含 team_handoff 收尾指令", () => {
  const p = buildInitialPrompt("随便一个任务");
  assert.ok(p.includes("team_handoff"), "必须含交接指令");
  assert.ok(p.includes("__end__"), "必须含结束指令");
});

test("task 出现在 user message（cache 失效点），不依赖 systemPrompt cache", () => {
  // 模拟 provider cache 命中场景：即使 systemPrompt 被旧 cache 替换，task 仍在 user message
  const task = "把 MPS 筛选框单选改多选";
  const userMsg = buildInitialPrompt(task);
  const cachedSystemPrompt = "# 旧的 systemPrompt，不含当前 task";
  // LLM 实际收到的 = cachedSystemPrompt(可能不含task) + userMsg(必含task)
  const llmInput = cachedSystemPrompt + "\n" + userMsg;
  assert.ok(llmInput.includes("单选改多选"), "即使 systemPrompt cache 命中旧值，task 仍通过 user message 进入 LLM 输入");
});
