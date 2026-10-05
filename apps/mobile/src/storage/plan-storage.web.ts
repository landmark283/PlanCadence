/**
 * 浏览器上的计划存储。
 *
 * ## 为什么需要这个文件
 *
 * `expo-file-system` 的平台列表是 **android / ios / tvos / expo-go —— 没有 web**
 * （v57 文档）。而项目的截图与端到端脚本都跑在 web 产物上，
 * 所以不能只在原生实现一遍。
 *
 * Metro 会按平台自动选文件：web 打包时用这个，原生打包时用 `plan-storage.ts`。
 * 两边导出同样的东西，调用方不需要知道自己跑在哪。
 *
 * ## 为什么是 localStorage 而不是内存
 *
 * 内存实现会让「落盘」这件事在 web 上假装成功——刷新就没了，
 * 而端到端脚本会因此验证不到任何持久化。localStorage 至少跨刷新存活，
 * 足以让流程脚本证明「写完能读回来」。
 */
import {
  FILE_EXT,
  SETTINGS_FILE_NAME,
  SNAPSHOT_DIR,
  planPath,
  snapshotPath,
  type PlanStorage,
  type SettingsStorage,
} from '@sp/shared';

const PREFIX = 'studyplan:';

/** SSR / 静态预渲染时没有 localStorage。所有访问都要过这一层 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // 隐私模式下访问 localStorage 会抛异常
    return null;
  }
}

const key = (relPath: string) => PREFIX + relPath;
const SNAPSHOT_NAME = new RegExp(`^v(\\d+)${FILE_EXT.replace(/\./g, '\\.')}$`);

export const storageRoot = 'localStorage://studyplan';
export const storageBackend = '浏览器存储' as const;
export const storageHint =
  '浏览器上 expo-file-system 不可用，改用 localStorage。刷新仍在，但清空站点数据会丢——真机上是文件系统。';

export const planStorage: PlanStorage = {
  async readPlan(planId) {
    return store()?.getItem(key(planPath(planId))) ?? null;
  },

  async writePlan(planId, text) {
    store()?.setItem(key(planPath(planId)), text);
  },

  async listSnapshots(planId) {
    const s = store();
    if (!s) return [];
    const dir = `${planId}/${SNAPSHOT_DIR}/`;
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIX + dir)) continue;
      const m = SNAPSHOT_NAME.exec(k.slice(PREFIX.length + dir.length));
      if (m) out.push(Number(m[1]));
    }
    return out.sort((a, b) => a - b);
  },

  async readSnapshot(planId, version) {
    return store()?.getItem(key(snapshotPath(planId, version))) ?? null;
  },

  async writeSnapshot(planId, version, text) {
    store()?.setItem(key(snapshotPath(planId, version)), text);
  },
};

export const appSettingsStorage: SettingsStorage = {
  async readSettings() {
    return store()?.getItem(key(SETTINGS_FILE_NAME)) ?? null;
  },

  async writeSettings(text) {
    store()?.setItem(key(SETTINGS_FILE_NAME), text);
  },
};
