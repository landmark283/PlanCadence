/**
 * 任务标记（tags）——内置目录与查表。
 *
 * ## 为什么任务上存的是 id 而不是文字
 *
 * 这一层存在的全部意义是**把「标记是什么」和「任务挂了哪些标记」分开**。
 * 任务上只有 `tags: ['tag_focus']`，标记长什么样、什么颜色、以后是否影响排期，
 * 全都在目录这一侧。所以将来要加：
 *
 *   · 「时间标记」——给 `Tag` 加字段（比如 `kind: 'time'` 和一个时间窗），
 *     让 `engine.ts` 读它。**任务上的数据一个字都不用改。**
 *   · 「自定义颜色」——往 `PlanFile.tags` 里写一条带 tone 的记录。
 *   · 「自定义标记」——给 `PlanFile.tags` 写一个界面。
 *
 * 三种扩展都不动任务。这就是框架，而它是靠**引用方式**建立的。
 *
 * ## 刻意没有加的东西
 *
 * 没有 `kind` / `payload` / `color` 这些预留字段。今天没有任何代码会读它们，
 * 而一个永远不被读的字段是最容易腐烂的东西——`commands.ts` 里已经为这条道理
 * 删过一次「按墙上时钟判断」的守卫（见那个文件里那段注释）。
 * 预留字段不是框架，**引用方式**才是。
 */
import type { PlanFile, Tag } from './schema.ts';

/**
 * 内置标记。
 *
 * 四条，都是「学生自己心里有数、但系统看不出来」的分类。
 * 刻意不含「重要/紧急」这种通用待办语汇——那类词在任何清单产品里都有，
 * 而对一个备赛计划没用；有用的恰恰是「这题我错了不止一次」这种学习状态。
 *
 * 加一条要慎重：卡片元信息行已经很挤了，标记是**学生自己打的**，不是系统堆的。
 */
export const BUILTIN_TAGS: readonly Tag[] = [
  { id: 'tag_focus', label: '重点', tone: 'accent' },
  { id: 'tag_after_exam', label: '等考完再做', tone: 'warning' },
  { id: 'tag_ask', label: '想问老师', tone: 'neutral' },
  { id: 'tag_error_prone', label: '易错', tone: 'danger' },
];

/** 只取 `plan.tags` 的那部分结构。查表不需要整份计划，测试也好造数据 */
export type TagCatalog = Pick<PlanFile, 'tags'>;

/**
 * 全部可用标记 = 内置 + 自定义。
 *
 * 同 id 时**自定义覆盖内置**：学生自己能改内置那四条的颜色和文案，
 * 就不需要再造一个新 id 出来。
 */
export function resolveTags(plan?: TagCatalog | null): Tag[] {
  const byId = new Map<string, Tag>(BUILTIN_TAGS.map((t) => [t.id, t]));
  for (const t of plan?.tags ?? []) byId.set(t.id, t);
  return [...byId.values()];
}

/** 查一条。查不到返回 undefined，**不抛**——见下面 tagsOf 的说明 */
export function tagById(plan: TagCatalog | null | undefined, id: string): Tag | undefined {
  return resolveTags(plan).find((t) => t.id === id);
}

/**
 * 渲染用：把一串 id 变成能画的标记，**认不出来的直接丢掉**。
 *
 * 不抛、不报错、也不占位。理由和任务卡上「资源 id 找不到就跳过」完全一样：
 * 一个已经不存在的标记 id 顶多让一个胶囊不显示，
 * 而如果让它变成校验错误，一条**改备注**的命令都会因为一个陈旧的标记 id 被整条拒绝。
 * 代价和收益完全不成比例。
 */
export function tagsOf(plan: TagCatalog | null | undefined, ids: readonly string[]): Tag[] {
  const catalog = resolveTags(plan);
  const byId = new Map(catalog.map((t) => [t.id, t]));
  return ids.flatMap((id) => {
    const t = byId.get(id);
    return t ? [t] : [];
  });
}
