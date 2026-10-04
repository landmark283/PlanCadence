/**
 * `PlanStorage` 的 Node 文件系统实现（server 与命令行工具共用）。
 *
 * 放在独立包里而不是 apps/server 里，是为了让 `tools/` 也能用它而不必把
 * Fastify 整套拖进命令行。移动端将来用 expo-file-system 另写一份，
 * 两边共用的是 `@sp/shared` 里的端口契约。
 *
 * 目录结构：
 *   <rootDir>/<planId>/plan.studyplan
 *   <rootDir>/<planId>/versions/v3.studyplan
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { planPath, snapshotPath } from '@sp/shared';
import type { PlanStorage } from '@sp/shared';
import { readTextOrNull, writeTextAtomic } from './atomic.ts';

export { readTextOrNull, writeTextAtomic, fileExists } from './atomic.ts';

/** 与 schema 里的 Id 规则保持一致（`^[a-z][a-z0-9_]{0,31}$`） */
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SNAPSHOT_RE = /^v(\d+)\.studyplan$/;

function assertSafeId(planId: string): void {
  // planId 正常来自已解析文件的 id 字段，但存储层不该假定调用方一定先校验过。
  // 没有这道检查，一个 `../../` 形式的 id 就能写到仓库外面去。
  if (!ID_RE.test(planId)) throw new Error(`非法的计划 id：${JSON.stringify(planId)}`);
}

export function nodeFsStorage(rootDir: string): PlanStorage {
  const root = path.resolve(rootDir);
  const planAbs = (id: string) => {
    assertSafeId(id);
    return path.join(root, planPath(id));
  };
  const snapAbs = (id: string, version: number) => {
    assertSafeId(id);
    if (!Number.isInteger(version) || version < 1) throw new Error(`非法的版本号：${version}`);
    return path.join(root, snapshotPath(id, version));
  };

  return {
    async readPlan(id) {
      return readTextOrNull(planAbs(id));
    },

    async writePlan(id, text) {
      await writeTextAtomic(planAbs(id), text);
    },

    async listSnapshots(id) {
      assertSafeId(id);
      const dir = path.dirname(snapAbs(id, 1));
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      return entries
        .map((name) => SNAPSHOT_RE.exec(name)?.[1])
        .filter((v): v is string => v !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    },

    async readSnapshot(id, version) {
      return readTextOrNull(snapAbs(id, version));
    },

    async writeSnapshot(id, version, text) {
      await writeTextAtomic(snapAbs(id, version), text);
    },
  };
}
