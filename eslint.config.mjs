import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    // Global ignores. NOTE: ESLint flat config lets only ONE global-ignores
    // object win (the last one replaces all earlier ones) — eslint-config-next
    // already declares { ignores: [".next/**", "out/**", ...] } internally, so
    // our additions must live here, in a merged final object, or they silently
    // disappear. Keep the preset's patterns plus ours.
    ignores: [
      // Skill documentation assets (official univer-sdk-skills templates) are
      // reference material, not app code — don't lint them.
      ".agents/skills/**",
      // Build output (also gitignored) — never lint generated bundles.
      // Note: no leading "/" — ESLint matches patterns against relative paths
      // via minimatch, where "/.next-pkg/**" fails to match on Windows.
      ".next/**",
      ".next-pkg/**",
      ".repro-dist/**",
      "out/**",
      "build/**",
      "release/**",
      "next-env.d.ts",
    ],
  },
  {
    files: ["**/*.cjs"],
    // CommonJS files legitimately use require() — the typescript-eslint
    // recommended preset flags every .cjs in the repo otherwise.
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      /**
       * React Compiler 的诊断规则，本项目**不适用**：
       *
       * `react-hooks/preserve-manual-memoization`（包括它报的
       * 「Existing memoization could not be preserved」与「memoized in source but not
       * in compilation output」两类）只有在项目真的跑 React Compiler 时才成立。
       * 本项目 next.config.mjs **没有启用 reactCompiler**，也没有 babel 配置，
       * 编译器根本不会运行 —— 这些 error 只会在 lint 里制造噪声，
       * 逼着人去改本来工作正常的 useCallback 依赖数组（改了反而有回归风险）。
       *
       * 与上面三条同类规则一样统一关闭（eslint-config-next 16 默认开成 error，
       * 会把 `pnpm run lint` 变成非零退出）。将来若真要接入 React Compiler，
       * 应连同 next.config 的 reactCompiler 一起打开本规则。
       */
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default eslintConfig;
