/**
 * 回合收尾守卫（turn-nudge）—— 解决「跑完没有总结、全程只有思考和命令行」。
 *
 * ## 问题
 * 弱模型（如 deepseek-flash）在「跑工具 → 读结果 → 再跑工具」的循环里不会自己
 * 收口：实测某会话 82 个 assistant 回合里 79 个**只带 thinking + toolCall、
 * 零正文**，连续 58 轮没有一个字给用户。界面上就表现为「只有思考和命令行，
 * 执行完没有任何结论」——而它自己并不知道用户看不到那些思考。
 *
 * ## 机制
 * 宿主在服务端盯住 assistant 回合的**可见输出**：
 *   · 一个回合只要带了非空 text 块 → 计数器清零（正常的「边做边说」不打扰）；
 *   · 连续 N 个回合都是「有 toolCall + thinking 但零 text」→ 判定为陷在工具循环里，
 *     立刻往**当前正在跑的这一轮**里插一条隐藏的收尾指令（steer）。
 *
 * 指令走 sendCustomMessage(customType, display:false)，不落盘、不显示成卡片，
 * 只在这一轮的下一次模型请求前生效——模型会把它当成系统提醒，停下来给结论。
 *
 * ## 为什么不用「回合结束后补一句继续」
 * 那样只会把循环延长（模型已经在 toolUse 循环里，再补一句它还是会先调工具）。
 * 必须**在循环内部**提醒，才能让它在这一轮收口。
 *
 * ## 开关
 * 默认开启，阈值 20。环境变量 `PI_TURN_NUDGE_TOOL_ONLY=0` 可关闭，
 * 设成其它正整数即改阈值（与项目里其它临时 A/B 开关一致）。
 *
 * ⚠️ 默认值必须落在**代码里**，不能只靠项目根目录的 `.env.local`：`electron-builder.yml`
 * 的 files 白名单不含 `.env*`，打包版 `resources/app` 下没有该文件，运行时回退到默认值。
 * 2026-09-14 曾把阈值写进 `.env.local` 而代码默认仍是 8，桌面版照旧 8 轮就打断。
 */

/** 注入的隐藏消息类型（前端不渲染它，仅供排查） */
export const TURN_NUDGE_CUSTOM_TYPE = "pi-studio-turn-nudge";

/** 连续多少个「纯工具回合」后提醒一次 */
export const TURN_NUDGE_DEFAULT_STREAK = 20;

/** 单次用户 prompt 最多提醒几次（防止把提醒本身变成新的循环） */
export const TURN_NUDGE_MAX_PER_RUN = 3;

/**
 * 读取阈值。返回 0 表示关闭。
 * env 优先于内置默认值：`PI_TURN_NUDGE_TOOL_ONLY`（0 关闭，其它正整数为阈值）。
 */
export function readTurnNudgeThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_TURN_NUDGE_TOOL_ONLY;
  if (raw === undefined || raw === "") return TURN_NUDGE_DEFAULT_STREAK;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return TURN_NUDGE_DEFAULT_STREAK;
  return n;
}

type ContentBlock = { type?: string; text?: string };

/**
 * 判断一个 assistant 回合是否属于「只有思考 + 工具、没有任何给用户看的正文」。
 *
 * - text 块存在但全是空白 → 仍算纯工具回合（模型偶尔会吐空 text）；
 * - 完全没有 content / 不是数组（异常数据）→ 不算，避免误报；
 * - **只要有一个非空 text 块就算正常回合**：正常的「先说明再动手」不该被打扰。
 */
export function isToolOnlyAssistantContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  let hasToolCall = false;
  for (const block of content as ContentBlock[]) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0) {
      return false;
    }
    if (block.type === "toolCall") hasToolCall = true;
  }
  return hasToolCall;
}

/**
 * 收尾提醒文本。
 *
 * 四个要点缺一不可：
 *   ① 明确告诉它「用户看不到你的思考和命令行」——否则它以为读者一直在跟着看；
 *   ② 给出汇报的结构（改了什么 / 验证结果 / 还差什么），避免它只回一句「已完成」；
 *   ③ 明确要求「停止调用工具」，否则它会先再跑一个命令来确认；
 *   ④ **不得向用户提及本提醒**——实测模型会原话转述“按宿主提醒本轮我先停手”，
 *     把宿主内部指令当成内容汇报给用户（2026-09-13 会话 01a0995b 实测）。
 */
export function turnNudgeInstruction(streak: number): string {
  return [
    `[pi-studio 宿主提醒] 你已经连续 ${streak} 个回合只调用工具、没有输出任何可见正文。`,
    "工具调用在界面上只显示为命令行，用户看不到你的思考过程，也拿不到任何结论——现在这一轮必须收尾。",
    "请立即停止调用工具，用一段正文向用户汇报：",
    "1) 做了什么改动（涉及哪些文件、行为有什么不同）；",
    "2) 验证结果（跑了什么、结果如何，失败的要说清楚）；",
    "3) 还有什么没做 / 需要用户确认的点。",
    "",
    "如果你的验证过程包含截图或像素/DOM 探测，用文字把你从中看到的结论写出来",
    "（哪里对了、哪里还不对），不要只丢统计数字。",
    "正文控制在几段以内，不要复述完整命令输出，也不要粘贴大段代码。",
    "",
    "★ 这条提醒是宿主内部机制，**不要向用户提及它本身**（不要写“按宿主提醒”之类的说法），",
    "直接给出正常的工作汇报即可。",
  ].join("\n");
}

/**
 * 纯状态机：喂入每个 assistant 回合的 content，返回「是否应该插入收尾提醒」。
 * 抽成独立类是为了能在单测里直接驱动（不依赖 pi 运行时）。
 */
export class TurnNudgeTracker {
  private streak = 0;
  private nudgesThisRun = 0;
  /** ★ 不用构造函数参数属性（`constructor(private x)`）：Node 的 strip-only
   *  模式无法处理，测试会直接 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。 */
  private readonly threshold: number;
  private readonly maxPerRun: number;

  constructor(threshold: number = TURN_NUDGE_DEFAULT_STREAK, maxPerRun: number = TURN_NUDGE_MAX_PER_RUN) {
    this.threshold = threshold;
    this.maxPerRun = maxPerRun;
  }

  /** 每个用户 prompt 开始时重置（一次任务内最多提醒 maxPerRun 次） */
  reset(): void {
    this.streak = 0;
    this.nudgesThisRun = 0;
  }

  /** 当前连续纯工具回合数（供测试与日志） */
  get currentStreak(): number {
    return this.streak;
  }

  /**
   * 观察一个 assistant 回合，返回是否需要提醒。
   * 触发后计数清零——再攒够一整轮才会提醒下一次，而不是之后每轮都催。
   */
  observe(content: unknown): boolean {
    if (this.threshold <= 0) return false;
    if (!isToolOnlyAssistantContent(content)) {
      this.streak = 0;
      return false;
    }
    this.streak += 1;
    if (this.streak < this.threshold) return false;
    if (this.nudgesThisRun >= this.maxPerRun) return false;
    this.nudgesThisRun += 1;
    this.streak = 0;
    return true;
  }
}
