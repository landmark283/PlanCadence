/**
 * 移动端的计划文件存储（Android / iOS）。
 *
 * ## 为什么用 `Paths.document` 而不是 `Paths.cache`
 *
 * 这是学生**唯一的一份计划**。cache 目录在系统空间紧张时会被清掉，
 * 那不叫缓存失效，那叫把学生的计划删了。
 *
 * ## 为什么用 `File` / `Directory` 类而不是旧的那套 `readAsStringAsync`
 *
 * SDK 54 起旧 API 被挪到 `expo-file-system/legacy`，在主入口上调用会直接抛错
 * （文档原文："This method will throw in runtime"）。查询过 v57 的文档后用的新 API。
 *
 * ## 路径布局沿用共享层的约定
 *
 * `planPath()` / `snapshotPath()` 是唯一真相源，这里不自己拼字符串——
 * 否则服务端按一套布局写、移动端按另一套读，问题只会在真机上暴露。
 */
import { Directory, File, Paths } from 'expo-file-system';
import {
  FILE_EXT,
  SETTINGS_FILE_NAME,
  SNAPSHOT_DIR,
  planPath,
  snapshotPath,
  type PlanStorage,
  type SettingsStorage,
} from '@sp/shared';

/** 应用私有文档目录。卸载应用才会清空，不进系统相册/下载目录 */
const ROOT = Paths.document;

/** 快照文件名 → 版本号，如 `v3.studyplan` → 3 */
const SNAPSHOT_NAME = new RegExp(`^v(\\d+)${FILE_EXT.replace(/\./g, '\\.')}$`);

/**
 * 由相对路径构造 `File`。
 *
 * 拆开再传给构造函数，而不是传一整个 `'plan_x/versions/v3.studyplan'`：
 * 构造函数的语义是「把若干段拼起来」，分段传才不会在某个平台上被当成字面文件名。
 */
function fileAt(relPath: string): File {
  return new File(ROOT, ...relPath.split('/'));
}

/** 确保目录存在。`idempotent` 让重复调用安全 */
function ensureDir(...segments: string[]): Directory {
  const dir = new Directory(ROOT, ...segments);
  dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export const storageRoot = ROOT.uri;
export const storageBackend = '设备文件系统' as const;
export const storageHint = '应用私有目录，卸载应用才会清空。不进系统相册，也不进下载目录。';

export const planStorage: PlanStorage = {
  async readPlan(planId) {
    const f = fileAt(planPath(planId));
    if (!f.exists) return null;
    return f.text();
  },

  async writePlan(planId, text) {
    // 计划文件在 planId 目录下，首次写入时目录还不存在
    ensureDir(planId);
    const f = fileAt(planPath(planId));
    if (!f.exists) f.create();
    f.write(text);
  },

  async listSnapshots(planId) {
    const dir = new Directory(ROOT, planId, SNAPSHOT_DIR);
    if (!dir.exists) return [];
    return dir
      .list()
      .filter((entry): entry is File => entry instanceof File)
      .map((f) => SNAPSHOT_NAME.exec(f.name)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  },

  async readSnapshot(planId, version) {
    const f = fileAt(snapshotPath(planId, version));
    return f.exists ? f.text() : null;
  },

  async writeSnapshot(planId, version, text) {
    ensureDir(planId, SNAPSHOT_DIR);
    const f = fileAt(snapshotPath(planId, version));
    if (!f.exists) f.create();
    f.write(text);
  },
};

/**
 * 应用设置（调试时钟、上次打开）。
 *
 * 复用同一套存储后端，而不是给设置再写一遍原生/web 两套文件——
 * `expo-file-system` 在 web 上不可用这件事只该被处理一次。
 */
export const appSettingsStorage: SettingsStorage = {
  async readSettings() {
    const f = fileAt(SETTINGS_FILE_NAME);
    return f.exists ? f.text() : null;
  },

  async writeSettings(text) {
    const f = fileAt(SETTINGS_FILE_NAME);
    if (!f.exists) f.create();
    f.write(text);
  },
};
