/**
 * lib/percho —— percho (github.com/Jaxton07/percho) transcript 大脑的 vendor 目录。
 * 来源：packages/shared/src（保持相对结构与文件内容，仅改顶层导入别名）。
 * 本文件是入口 barrel，等价 percho 的 packages/shared/src/index.ts（只导出 chat 迁移相关子集，
 * 不引 lan/ipc/packages/ui-plugins/update 等无关业务类型）。
 *
 * 迁移说明见 docs/percho-chat-migration.md。
 */

export * from "./errors";
export * from "./session";
export * from "./skill-invocation";
export * from "./subagent";
export * from "./todo";
export * from "./transcript";
