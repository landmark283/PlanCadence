/**
 * 计划文件的读写（序列化 / 反序列化 / 版本快照路径）。
 *
 * 设计约束：
 *  1. **纯字符串进出**。这里不做任何文件系统操作——`PlanStorage` 只是端口接口，
 *     真正的实现在各端（server 用 node:fs，mobile 用 expo-file-system）。
 *     这样共享层依然不碰任何 Node API，Hermes 上也跑得起来。
 *  2. **只认 JSON_SCHEMA**。默认 YAML schema 允许 `!!js/function` 之类的标签，
 *     一个被篡改的计划文件就能变成代码执行入口。我们的数据是纯 JSON 形状，
 *     用 JSON_SCHEMA 既够用又堵死了这条路。
 *  3. 解析失败要给**人能看懂的错误**，因为它会直接显示在移动端界面上。
 */
// js-yaml 5 是 ESM-only 且【没有 default 导出】，必须具名导入。
// 同时它的 DumpOptions 相比 v4 删掉了 quotingType / forceQuotes，
// 保留了 lineWidth / sortKeys / noRefs。
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { PlanFile, SCHEMA_ID, FILE_EXT, PLAN_FILE_NAME, validatePlan } from './schema.ts';
import type { PlanFile as PlanFileType, PlanIssue } from './schema.ts';

export const SNAPSHOT_DIR = 'versions';

/** 文件头注释。这是「自定义格式」对外的门面，会出现在每个 .studyplan 文件顶部。 */
const HEADER = `# studyplan/v1 —— 学习计划
#
# 这是一个可被人类和机器共同维护的计划文件：字段语义、状态机与不变量定义在
# packages/shared/src/plan/schema.ts，本文件只承载数据。
#
# 状态取值：todo(未开始) / doing(进行中) / done(完成) / skipped(主动跳过) / blocked(被卡住)
# 注意 skipped 与 blocked 语义不同：前者是意愿问题，后者是条件问题，触发的重排策略不同。
#
# 文件由程序写入为主；手工编辑请保持 schema / id / version 三个字段不变。`;

/* ------------------------------------------------------------------ *
 * 序列化
 * ------------------------------------------------------------------ */

/** 深拷贝并丢弃 undefined 字段：js-yaml 的 JSON_SCHEMA 无法表示 undefined */
function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(pruneUndefined) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = pruneUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function serializePlan(plan: PlanFileType, opts: { header?: boolean } = {}): string {
  const body = dump(pruneUndefined(plan), {
    schema: JSON_SCHEMA,
    noRefs: true, // 不生成 &anchor / *alias，人类要能直接读
    lineWidth: -1, // 不折行，避免长标题被折断后难以人工编辑
    sortKeys: false, // 保持 schema 定义的字段顺序
  });
  return opts.header === false ? body : `${HEADER}\n${body}`;
}

/* ------------------------------------------------------------------ *
 * 反序列化
 * ------------------------------------------------------------------ */

export type ParseResult =
  | { ok: true; plan: PlanFileType; warnings: PlanIssue[] }
  | { ok: false; error: string; issues: PlanIssue[] };

function issueOf(path: string, message: string): PlanIssue {
  return { level: 'error', path, message };
}

export function parsePlan(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = load(text, { schema: JSON_SCHEMA });
  } catch (e) {
    return { ok: false, error: `YAML 解析失败：${(e as Error).message}`, issues: [] };
  }

  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '文件内容为空，或顶层不是一个对象', issues: [] };
  }

  // 版本闸门放在最前面：格式不认就别往下走，否则报出来的错会误导人
  const schemaId = (raw as { schema?: unknown }).schema;
  if (schemaId !== SCHEMA_ID) {
    return {
      ok: false,
      error: `不支持的格式版本：${String(schemaId ?? '(缺失 schema 字段)')}，本程序只认 ${SCHEMA_ID}`,
      issues: [issueOf('schema', `期望 ${SCHEMA_ID}`)],
    };
  }

  const parsed = PlanFile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => issueOf(i.path.join('.') || '(根)', i.message));
    return {
      ok: false,
      error: `字段校验未通过（${issues.length} 处）：${issues
        .slice(0, 3)
        .map((i) => `${i.path} ${i.message}`)
        .join('；')}${issues.length > 3 ? ' …' : ''}`,
      issues,
    };
  }

  const semantic = validatePlan(parsed.data);
  const hard = semantic.filter((i) => i.level === 'error');
  if (hard.length) {
    return {
      ok: false,
      error: `语义校验未通过（${hard.length} 处）：${hard
        .slice(0, 3)
        .map((i) => `${i.path} ${i.message}`)
        .join('；')}`,
      issues: hard,
    };
  }

  return { ok: true, plan: parsed.data, warnings: semantic.filter((i) => i.level === 'warn') };
}

/** 把校验问题渲染成多行文本，便于展示在移动端或写进日志 */
export function formatIssues(issues: PlanIssue[]): string {
  if (!issues.length) return '（无问题）';
  return issues.map((i) => `${i.level === 'error' ? '✕' : '!'} ${i.path}: ${i.message}`).join('\n');
}

/* ------------------------------------------------------------------ *
 * 路径约定（纯字符串，不含平台细节）
 * ------------------------------------------------------------------ */

/** 当前计划文件的相对路径，如 `plan_czw01/plan.studyplan` */
export function planPath(planId: string): string {
  return `${planId}/${PLAN_FILE_NAME}`;
}

/** 版本快照的相对路径，如 `plan_czw01/versions/v3.studyplan` */
export function snapshotPath(planId: string, version: number): string {
  return `${planId}/${SNAPSHOT_DIR}/v${version}${FILE_EXT}`;
}

/* ------------------------------------------------------------------ *
 * 存储端口
 * ------------------------------------------------------------------ */

/**
 * 存储端口。**故意不提供实现**：
 *  - `apps/server` 用 `node:fs/promises`
 *  - `apps/mobile` 用 `expo-file-system`
 *
 * 共享层只声明契约，因此可以继续在 Hermes 上运行而不引入 Node API。
 */
export interface PlanStorage {
  readPlan(planId: string): Promise<string | null>;
  writePlan(planId: string, text: string): Promise<void>;
  /** 返回已存在的快照版本号，升序 */
  listSnapshots(planId: string): Promise<number[]>;
  readSnapshot(planId: string, version: number): Promise<string | null>;
  writeSnapshot(planId: string, version: number, text: string): Promise<void>;
}

/**
 * 每次成功变更后落一份整份快照。
 *
 * 回滚刻意走快照而不是重放命令：重放要求命令永久向后兼容，代价高且容易错；
 * 快照恢复简单可靠。文件只有几十 KB，不值得为省这点空间冒风险。
 *
 * `previous.text` 要求传入**原始文件文本**，而不是「把新计划改个 version 再序列化」——
 * 后者看着等价，实际会把新版才有的字段一起写进旧版快照里，回滚后就多出不该存在的数据。
 */
export async function saveWithSnapshot(
  storage: PlanStorage,
  plan: PlanFileType,
  previous?: { version: number; text: string }
): Promise<void> {
  if (previous && previous.version < plan.version) {
    const existing = await storage.readSnapshot(plan.id, previous.version);
    if (existing === null) {
      // 上一步的快照丢了就补写一份，否则回滚链会断在这里
      await storage.writeSnapshot(plan.id, previous.version, previous.text);
    }
  }
  await storage.writePlan(plan.id, serializePlan(plan));
}
