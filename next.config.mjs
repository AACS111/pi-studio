import { readFileSync } from "fs";
import { join } from "path";

const root = import.meta.dirname;
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
let piVersion = "unknown";
try {
  const piPkgPath = join(root, "node_modules/@earendil-works/pi-coding-agent/package.json");
  piVersion = JSON.parse(readFileSync(piPkgPath, "utf8")).version;
} catch { /* package not found, use default */ }

const nextConfig = {
  // 打包桌面应用（electron-builder）时用独立目录构建，避免污染 dev 的 .next
  distDir: process.env.PI_WEB_DIST_DIR || ".next",
  // 浏览器代理的路径式 URL（/api/browser/proxy/<b64>/）
  // 目录型请求必须保留尾斜杠，否则 308 重定向后动态 import 相对解析又断掉
  skipTrailingSlashRedirect: true,
  serverExternalPackages: [
    "undici",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  allowedDevOrigins: ['192.168.*.*'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
