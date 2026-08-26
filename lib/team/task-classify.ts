/**
 * 任务复杂度判定（发布即判定）：
 *   simple  → solo 路径：入口角色（leader）带全套工具像普通会话一样直接读改代码交付
 *   complex → 编排路径：leader 只拆任务+派活+记决策，下游角色接力（复杂/多模块/系统级）
 *
 * 判定规则：
 *   1. 命中多模块 / 系统级 / 跨模块信号 → complex（大工程，需要多角色协作）
 *   2. 其余一律 → simple（solo）
 *
 * 设计目标（站在用户角度）：绝大多数用户任务是「加一个功能 / 修一个 bug / 优化一处」这类
 *   **单点、可单人闭环**的需求。solo 路径（一个带全套工具的 Agent）能读改代码 + 真实验证，
 *   又快又稳；只有明确是「搭系统 / 多模块 / 端到端」的大工程才走多角色编排。
 *   因此把默认偏向从「宁可 complex」改为「默认 simple、仅明确多模块走 complex」——
 *   避免把单点功能强行拆成多角色接力导致慢 / 丢失上下文 / 自相矛盾（正是此前项目组超时的根因）。
 */

export type TaskComplexity = "simple" | "complex";

/** 多模块 / 系统级 / 跨模块 —— 需要多角色协作（complex） */
const MULTI_PART_PATTERN =
  /(整个|完整系统|端到端|多模块|多个模块|多个功能|多角色|整站|全站|全栈|数据库|后端|前端|支付|登录系统|权限系统|从零搭建|从0搭建|重构整个|重构.*系统|系统架构|架构设计|架构|集成多个|跨模块|跨端|跨系统|大型|平台|整套|全家桶|一套系统)/;

export function classifyTask(task: string): TaskComplexity {
  const t = task.trim();
  if (!t) return "complex"; // 空任务兜底走复杂路径

  // 明确的「多模块 / 系统级 / 跨模块」大工程才走编排；其余默认 solo
  if (MULTI_PART_PATTERN.test(t)) return "complex";
  return "simple";
}
