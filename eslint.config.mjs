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
      "out/**",
      "build/**",
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
    },
  },
];

export default eslintConfig;
