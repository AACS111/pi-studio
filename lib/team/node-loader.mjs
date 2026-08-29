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
      const abs = resolve(projectRoot, specifier.slice(2));
      try {
        return nextResolve(pathToFileURL(abs + ".ts").href, context);
      } catch (err) {
        // 目录类型（如 @/lib/percho → lib/percho/index.ts）
        try {
          return nextResolve(pathToFileURL(abs + "/index.ts").href, context);
        } catch {
          throw err;
        }
      }
    }
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      if (!/\.[a-z]+$/i.test(specifier)) {
        try {
          return nextResolve(specifier + ".ts", context);
        } catch {
          try {
            return nextResolve(specifier + "/index.ts", context);
          } catch {
            // 无 .ts 时回退原样
          }
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
