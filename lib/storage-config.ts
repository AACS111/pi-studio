import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";
import { normalizeSlashes } from "./allowed-roots";

/**
 * pi-studio 运行时数据目录（上传文件 + 内部状态）配置。
 *
 * 数据不再存放在 pi 自身的数据目录（~/.pi/agent）里，而是默认放在
 * pi-studio 项目根目录下的 `pi-web-uploads/`（即启动 dev/start 时的
 * process.cwd() 目录）。
 *
 * 用户可以在 UI（上传管理器 → 修改目录）或手工编辑配置文件
 * `<项目根>/.pi-web-config.json` 修改存储位置：
 *
 *   { "uploadsDir": "D:/shared/uploads" }   // 绝对路径
 *   { "uploadsDir": "data/files" }          // 相对路径（相对项目根，正/反斜杠均可）
 *
 * 删除该字段（或通过 UI「恢复默认」）即回到默认的项目目录。
 * 优先级：环境变量 PI_WEB_UPLOADS_DIR（显式覆盖）> 配置文件 uploadsDir >
 * 环境变量 PI_WEB_UPLOADS_DEFAULT_DIR（Electron 默认）> 默认项目目录。
 */

export const DEFAULT_DATA_DIR_NAME = "pi-web-uploads";

/** pi-studio 项目根目录（Next.js 保证 process.cwd() 是启动目录 = 项目根）。 */
function getProjectRoot(): string {
  return process.cwd();
}

/** 用户可手工编辑的配置文件路径：<项目根>/.pi-web-config.json */
export function getConfigPath(): string {
  return join(getProjectRoot(), ".pi-web-config.json");
}

interface PiWebConfig {
  uploadsDir?: string;
}

function readConfig(): PiWebConfig {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return {};
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed.uploadsDir === "string" && parsed.uploadsDir.trim()) {
      return { uploadsDir: parsed.uploadsDir.trim() };
    }
  } catch {
    /* 配置损坏时回退默认 */
  }
  return {};
}

function writeConfig(config: PiWebConfig): void {
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = configPath + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  renameSync(tmp, configPath);
}

function resolveConfiguredDir(raw: string): string {
  return normalizeSlashes(isAbsolute(raw) ? raw : resolve(getProjectRoot(), raw));
}

/** 计算数据目录（不创建）。优先级：env（显式覆盖）> 配置文件 > Electron 默认 > 项目默认。 */
export function resolveDataDir(): string {
  // PI_WEB_UPLOADS_DIR 是运维/部署用的显式覆盖（最高优先级），
  // 不用于 Electron 默认值——那样会盖掉用户在 UI 里「修改目录」写入的配置。
  const env = process.env.PI_WEB_UPLOADS_DIR?.trim();
  if (env) return resolveConfiguredDir(env);
  const configured = readConfig().uploadsDir;
  if (configured) return resolveConfiguredDir(configured);
  // Electron 桌面模式的默认数据目录（userData/pi-web-uploads）：优先级低于配置，
  // 这样用户改目录能生效；浏览器模式不设此变量，回到项目默认。
  const defaultEnv = process.env.PI_WEB_UPLOADS_DEFAULT_DIR?.trim();
  if (defaultEnv) return resolveConfiguredDir(defaultEnv);
  return normalizeSlashes(join(getProjectRoot(), DEFAULT_DATA_DIR_NAME));
}

/** 返回（并确保存在）pi-studio 数据目录。上传文件直接存放在这里。 */
export function getDataDir(): string {
  const dir = resolveDataDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录不可创建时保持原样，后续写入会报错 */
  }
  return dir;
}

/** 内部状态目录（open-file 标记、用户编辑记录、univer CLI home）。
 *  位于数据目录下的 `.internal/`，对用户隐藏（上传列表会过滤点开头条目）。 */
export function getInternalDir(): string {
  return normalizeSlashes(join(getDataDir(), ".internal"));
}

/**
 * 持久化用户选择的存储目录；传空字符串恢复默认。
 * 返回生效后的数据目录。相对路径相对项目根解析。
 */
export function setDataDir(value: string): string {
  const config = readConfig();
  const v = value.trim();
  if (!v) {
    delete config.uploadsDir;
  } else {
    config.uploadsDir = v;
  }
  writeConfig(config);
  return getDataDir();
}

/**
 * 一次性迁移旧版数据（~/.pi/agent/pi-studio-*）到新的项目数据目录。
 * 尽力而为、幂等：单文件失败不影响其余；目标已存在时不覆盖；
 * 遗留的旧 univer daemon 会先被终止（它是 pi-studio 自己启动的），否则它会
 * 锁住旧 home 目录和正在打开的 .univer 文件导致移动失败。
 * 由 instrumentation.ts 在服务启动时调用；残留项会在下次启动时重试。
 */
export function migrateLegacyData(): void {
  const legacyRoot = join(homedir(), ".pi", "agent");
  const dataDir = getDataDir();

  // 0) 终止旧版 univer daemon（pi-studio 自己启动的子进程，旧 home 下的 daemon.pid）。
  //    不杀掉的话它会把旧 home 和正在服务的 .univer 文件锁住，rename 全部 EBUSY。
  stopLegacyUniverDaemon(legacyRoot);

  // 1) 上传文件：逐个移动，避免单个文件被占用导致整体失败。
  //    rename 失败（Windows 下 EBUSY）时回退为 copy+校验：锁只允许读、不允许改名/删除时，
  //    先把内容复制到新位置（应用只读新位置），遗留的旧文件等下次启动锁释放后再删。
  const legacyUploads = join(legacyRoot, "pi-web-uploads");
  try {
    if (existsSync(legacyUploads)) {
      for (const name of readdirSync(legacyUploads)) {
        if (name.startsWith(".")) continue;
        const from = join(legacyUploads, name);
        const to = join(dataDir, name);
        if (existsSync(to)) {
          // 目标已存在：可能是上次 copy 成功但删除失败留下的旧文件，重试删除。
          try {
            rmSync(from, { force: true });
          } catch {
            /* 仍被锁，下次再试 */
          }
          continue;
        }
        try {
          renameSync(from, to);
        } catch {
          try {
            copyFileSync(from, to);
            // 复制后校验大小，防止读到写入中途的文件（源文件一般已静止）。
            if (statSync(from).size !== statSync(to).size) {
              rmSync(to, { force: true });
            }
          } catch {
            /* 复制失败则保留旧文件 */
          }
        }
      }
      try {
        if (readdirSync(legacyUploads).length === 0) rmdirSync(legacyUploads);
      } catch {
        /* 非空目录保留 */
      }
    }
  } catch {
    /* 旧目录不可读时跳过 */
  }

  // 2) 内部状态文件（open-file 标记 / 用户编辑记录 / univer CLI home）
  const internalDir = getInternalDir();
  const legacyItems: Array<[string, string]> = [
    ["pi-web-open-file.json", "pi-web-open-file.json"],
    ["pi-web-univer-user-edits.json", "pi-web-univer-user-edits.json"],
    ["pi-web-univer", "univer"],
  ];
  for (const [fromName, toName] of legacyItems) {
    const from = join(legacyRoot, fromName);
    const to = join(internalDir, toName);
    try {
      if (!existsSync(from) || existsSync(to)) continue;
      mkdirSync(internalDir, { recursive: true });
      renameSync(from, to);
    } catch {
      /* 尽力而为，失败则新位置重新初始化 */
    }
  }
}

/** 终止旧版 pi-studio univer daemon（读取旧 home 下的 daemon.pid）。 */
function stopLegacyUniverDaemon(legacyRoot: string): void {
  try {
    const pidFile = join(legacyRoot, "pi-web-univer", "daemon", "daemon.pid");
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true, timeout: 8000 });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* 进程可能已退出 */
      }
    }
  } catch {
    /* 尽力而为 */
  }
}
