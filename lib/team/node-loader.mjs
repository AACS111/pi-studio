/**
 * Node 测试用 loader：
 *  - 无扩展名的相对导入 → 解析为 .ts（项目 lib 内部 import 不带扩展名）
 *  - `@/` 路径别名 → 项目根（Next.js bundler 风格）
 * 仅测试用。用法：node --experimental-transform-types --import ./lib/team/node-loader.mjs --test ...
 */
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return nextResolve(pathToFileURL(resolve(projectRoot, specifier.slice(2)) + ".ts").href, context);
    }
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      if (!/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          // 无 .ts 时回退原样（可能是目录/index）
        }
      }
    } else if (!specifier.startsWith("node:") && !specifier.startsWith("data:")) {
      // 包导入（如 next/server）：Next 的 exports 需要 .js 后缀，原生解析失败时
      // 回退 specifier + ".js"（仅失败路径触发，不影响正常解析的性能）
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        try {
          return nextResolve(specifier + ".js", context);
        } catch {
          throw err;
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
