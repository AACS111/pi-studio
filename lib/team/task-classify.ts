/**
 * 任务复杂度判定（发布即判定）：
 *   simple  → solo 路径：入口角色（leader）带全套工具像普通会话一样直接读改代码交付
 *   complex → 编排路径：leader 只拆任务+派活+记决策，下游角色接力（复杂/多模块/系统级）
 *
 * 判定规则：
 *   1. 命中多模块 / 系统级 / 跨模块信号 → complex（大工程，多角色协作）
 *   2. 命中「跨前后端改造」信号 → complex（同时涉及后端类 + 前端 UI + 服务端数据逻辑）
 *   3. 其余一律 → simple（solo）
 *
 * 设计目标（站在用户角度）：绝大多数用户任务是「加一个功能 / 修一个 bug / 优化一处」这类
 *   **单点、可单人闭环**的需求。solo 路径（一个带全套工具的 Agent）能读改代码 + 真实验证，
 *   又快又稳；只有明确是「搭系统 / 多模块 / 端到端」的大工程才走多角色编排。
 *   因此把默认偏向从「宁可 complex」改为「默认 simple、仅明确多模块走 complex」——
 *   避免把单点功能强行拆成多角色接力导致慢 / 丢失上下文 / 自相矛盾。
 *
 * 2026-08-26 补丁（修复 maxTurns 耗尽根因）：
 *   此前裸匹配「前端|后端」太粗（单点任务只要提一句“前端”就误判 complex），又缺少
 *   「跨前后端改造」信号，导致 d2o MPS 这类任务（@Handler + @ServiceImpl + 页面筛选框
 *   + sheet 版本逻辑）被判 simple -> solo。solo 下 leader 单角色一手读前后端全部代码，
 *   maxTurns=20 全耗在探索，还没改就被掐断。这里去掉裸「前端|后端」，改用精确的
 *   «后端类 + 前端 UI + 服务端数据逻辑»三信号联合判定，命中才走多角色分前端/后端。 */

export type TaskComplexity = "simple" | "complex";

/** 多模块 / 系统级 / 跨模块 —— 需要多角色协作（complex）
 *   注意：不再裸匹配「前端|后端」（太粗，会误伤单点任务），跨前后端单独用 FRONT_BACK 判定。 */
const MULTI_PART_PATTERN =
  /(整个|完整系统|端到端|多模块|多个模块|多个功能|多角色|整站|全站|全栈|数据库|支付|登录系统|权限系统|从零搭建|从0搭建|重构整个|重构.*系统|系统架构|架构设计|集成多个|跨模块|跨端|跨系统|大型|平台|整套|全家桶|一套系统|\d+\s*个(?:独立)?(?:模块|功能|服务|子系统|微服务|任务)|多个独立(?:模块|功能|服务)|独立模块|数个模块|多个子系统)/;

/** 跨前后端改造信号（三个独立信号联合命中才算 complex）：
 *   1. backend：点了后端类 —— @Handler / @Service(Impl) / Controller / 后端 / 接口    
 *   2. frontend：涉到前端 UI —— 页面 / 筛选框 / 下拉 / 单选 / 多选 / Select / Vue / 搜索框
 *   3. serverdata：涉到服务端数据逻辑 —— sheet / 版本 / latestVersion / 查询(结果|前面的) / 比对 / 数据
 *   三者同时出现 → 判定「跨前后端重构」（需前端角色改 UI + 后端角色改接口/数据逻辑，多角色分摊），
 *   避免单入口角色一手读前后端把 maxTurns 耗在探索。 */
const FRONT_BACK_BACKEND = /(@\w*Handler|@\w*Service(Impl)?|@\w*Controller|后端|接口|ServiceImpl|\bHandler\b)/i;
const FRONT_BACK_FRONTEND = /(页面|筛选框|下拉|单选|多选|Select|Vue|搜索框|前端)/i;
const FRONT_BACK_SERVERDATA = /(sheet|版本|latestVersion|latest\s*version|查询|比对|数据)/i;

/** 显式「前后端」字面（单独命中即 complex，无需三信号） */
const FRONT_BACK_EXPLICIT =
  /(前后端|前端和后端|后端和前端|前端与后端|同时.*前端.*后端|前端.*和.*后端|跨前后端)/;

export function classifyTask(task: string): TaskComplexity {
  const t = task.trim();
  if (!t) return "complex"; // 空任务兜底走复杂路径

  // 明确「跨前后端」字面 → 直接 complex
  if (FRONT_BACK_EXPLICIT.test(t)) return "complex";

  // 明确的「多模块 / 系统级 / 跨模块」大工程才走编排
  if (MULTI_PART_PATTERN.test(t)) return "complex";

  // 跨前后端改造：后端类 + 前端 UI + 服务端数据逻辑 三信号联合命中
  if (FRONT_BACK_BACKEND.test(t) && FRONT_BACK_FRONTEND.test(t) && FRONT_BACK_SERVERDATA.test(t)) {
    return "complex";
  }

  return "simple";
}
