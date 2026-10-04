/**
 * 检索 —— 把学生的情况变成「该给他哪几条资料」。纯函数，可测、可复现。
 *
 * ## 为什么打分是确定性的而不是让模型挑
 *
 * 模型的活是**描述**，不是**决定给什么**。让模型从候选里挑，它会挑得挺像样，
 * 但同一份档案问两次可能给出不同结果——而学生看到的「系统给我找了这些」
 * 应该是一个能解释、能复现的判断。所以这一层做成加权匹配：
 * 命中的标签越长（越具体）分越高，「动态规划」命中比「算法」命中值钱得多。
 *
 * 模型的入口在别处：它可以对已经定下来的资源写说明（见 §7 的契约）。
 *
 * ## 匹配是子串包含，不做分词
 *
 * 检索的输入是学生自己写的中文（「动态规划老是不会」「DFS/BFS 模板默写」）。
 * 中文分词要引词典，而这里的标签本身就是从学生说法里挑出来的词，
 * 直接看标签是否出现在文本里就够了，而且完全可预测。
 */
import type { Resource, ResourceInput } from '../plan/schema.ts';
import {
  FALLBACK_IDS,
  LIBRARY,
  LIBRARY_SNAPSHOT,
  LIBRARY_SOURCE,
  entryById,
  type Level,
  type LibraryEntry,
} from './library.ts';

/** 水平从低到高。用来判断「这条资源是不是超出他的水平太多」 */
const LEVEL_ORDER: Level[] = ['beginner', 'basic', 'intermediate', 'advanced'];

export type RetrievedResource = {
  resource: Resource;
  /** 命中这个词才推的。界面上用来说明「我按什么找的」 */
  matched: string[];
};

/** 库条目 → 计划里的资源。`verifiedAt` 是快照日期，`source` 写明是快照 */
export function toResource(e: LibraryEntry): Resource {
  return {
    id: e.id,
    title: e.title,
    url: e.url,
    kind: e.kind,
    verifiedAt: `${LIBRARY_SNAPSHOT}T00:00:00+08:00`,
    source: LIBRARY_SOURCE,
    deadline: null,
  };
}

/** 学生水平低于这条资源要求的下限时要跳过 */
function levelOk(e: LibraryEntry, level: Level | null | undefined): boolean {
  if (!e.minLevel || !level) return true;
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(e.minLevel);
}

const norm = (s: string) => s.toLowerCase();

/**
 * 命中「这条主要讲什么」的加成。
 *
 * 6 这个数是从一次真实的错误排序定下来的：查「动态规划」时，
 * 泛泛覆盖 DP 的通用课程和 OI Wiki 的 DP 专页命中同一个标签、各得 4 分，
 * 打平之后按 id 排序，泛泛的那条反而赢了。
 * 加成必须**明显大于最长标签的长度**（4），专页才压得住泛泛的条目。
 */
const TOPIC_BONUS = 6;

/**
 * 一条资源对一段文本的得分。
 *
 * 两层：命中的标签按**标签长度**加权（`『动态规划』` 4 分 > `『算法』` 2 分），
 * 命中 `topic` 再加一笔 `TOPIC_BONUS`。
 */
function score(e: LibraryEntry, text: string): string[] {
  const matched = e.tags.filter((tag) => text.includes(norm(tag)));
  if (text.includes(norm(e.topic))) matched.push(e.topic);
  return matched;
}

/** 得分：标签长度合计 + 主题加成。主题已并进 `matched`，这里单独算以免重复计长度 */
function pointsOf(e: LibraryEntry, matched: string[]): number {
  const tagPoints = matched.filter((m) => m !== e.topic).reduce((s, t) => s + t.length, 0);
  const topicHit = matched.includes(e.topic) ? TOPIC_BONUS : 0;
  return tagPoints + topicHit;
}

export type SearchOptions = {
  /** 最多返回几条 */
  limit?: number;
  level?: Level | null;
  /** 已经在计划里的资源 id，不要重复给 */
  exclude?: readonly string[];
  /**
   * 一条都没命中时，是否退回通用入口组。默认 true。
   *
   * 按任务逐条挂资源时**必须关掉**：否则每条没匹配上的任务都会被塞一条
   * 「OI Wiki」「洛谷」进去，`limit` 立刻被撑满，真正相关的那几条反而进不来。
   * 兜底组只该在学生主动检索、而且一条都没找到时出现一次。
   */
  fallback?: boolean;
};

/**
 * 按一段文本检索资料。
 *
 * 一条都没命中且 `fallback` 为真时返回 `FALLBACK_IDS` 那组通用入口——
 * 空面板会让学生以为「系统没找到」，而其实是他给的信息太少。
 * 给通用入口更诚实，也更有用。
 */
export function searchResources(query: string, opts: SearchOptions = {}): RetrievedResource[] {
  const limit = opts.limit ?? 4;
  const text = norm(query);
  const skip = new Set(opts.exclude ?? []);

  const scored = LIBRARY.filter((e) => !skip.has(e.id) && levelOk(e, opts.level))
    .map((e) => {
      const matched = score(e, text);
      return { e, matched, points: pointsOf(e, matched) };
    })
    .filter((x) => x.points > 0)
    // 同分时按 id 排，保证顺序稳定——不然同一次检索两次跑出来顺序会变
    .sort((a, b) => b.points - a.points || (a.e.id < b.e.id ? -1 : 1));

  const picked = scored.slice(0, limit);
  if (picked.length || opts.fallback === false) {
    return picked.map((x) => ({ resource: toResource(x.e), matched: x.matched }));
  }

  return FALLBACK_IDS.filter((id) => !skip.has(id))
    .map((id) => entryById(id))
    .filter((e): e is LibraryEntry => e !== undefined && levelOk(e, opts.level))
    .slice(0, limit)
    .map((e) => ({ resource: toResource(e), matched: [] }));
}

/** 赛事库里那几条。**不带截止日**——理由见 library.ts 里赛事那一段注释 */
export function localContestFeed(opts: { exclude?: readonly string[] } = {}): RetrievedResource[] {
  const skip = new Set(opts.exclude ?? []);
  return LIBRARY.filter((e) => e.kind === 'contest' && !skip.has(e.id)).map((e) => ({
    resource: toResource(e),
    matched: [],
  }));
}

/* ------------------------------------------------------------------ *
 * 挂到任务上
 * ------------------------------------------------------------------ */

export type AttachInput = {
  tasks: readonly { id: string; title: string }[];
  profile: {
    weakSpots: readonly string[];
    level?: Level | null;
    goalStatement?: string | null;
  };
  /** 每条任务最多挂几条。默认 1——挂多了任务卡会变成链接列表 */
  perTask?: number;
  /** 整个计划最多带多少条。默认 8 */
  limit?: number;
  /** 已经在计划里的资源 id */
  exclude?: readonly string[];
  /** 额外要一并放进去的资源（如实时抓回的赛事），不参与匹配。必须是**已经成型**的资源 */
  extra?: readonly Resource[];
};

export type AttachOutput = {
  resources: Resource[];
  links: { taskId: string; resourceIds: string[] }[];
  /** 检索实际用到的关键词，界面要如实告诉学生「我按什么找的」 */
  queries: string[];
};

/**
 * 按任务逐条检索并挂上资料，再用学生自述的薄弱点补一轮。
 *
 * 两步而不是一步：只按任务标题找的话，同一个知识点会在好几条任务上
 * 反复推同一条资源（去重之后就只剩一两条，面板显得很空）；
 * 只按档案找的话，资源会和具体任务脱钩，学生看不出「这条是给哪件事用的」。
 */
export function attachPlanResources(input: AttachInput): AttachOutput {
  const perTask = input.perTask ?? 1;
  const limit = input.limit ?? 8;
  const level = input.profile.level ?? null;

  const picked = new Map<string, RetrievedResource>();
  const links: { taskId: string; resourceIds: string[] }[] = [];
  const used = new Set(input.exclude ?? []);

  for (const t of input.tasks) {
    if (picked.size >= limit) break;
    const hits = searchResources(t.title, {
      limit: perTask,
      level,
      exclude: [...used, ...picked.keys()],
      // 关键：按任务挂时不走兜底组，见 SearchOptions.fallback 的注释
      fallback: false,
    });
    if (!hits.length) continue;
    for (const h of hits) picked.set(h.resource.id, h);
    links.push({ taskId: t.id, resourceIds: hits.map((h) => h.resource.id) });
  }

  // 档案层面补一轮，用的就是学生自己说的薄弱点
  const queries = input.profile.weakSpots.length
    ? [...input.profile.weakSpots]
    : [input.profile.goalStatement ?? '基础算法'];
  for (const q of queries) {
    if (picked.size >= limit) break;
    for (const h of searchResources(q, {
      limit: 2,
      level,
      exclude: [...used, ...picked.keys()],
      fallback: false,
    })) {
      picked.set(h.resource.id, h);
    }
  }

  // 一条都没挂上（任务标题太笼统、档案也空）：退回任务标题整体再试一次，
  // 让 searchResources 自己走它的兜底组
  if (picked.size === 0) {
    const joined = input.tasks.map((t) => t.title).join(' ') || queries.join(' ');
    for (const h of searchResources(joined, { limit: 4, level, exclude: [...used] })) {
      picked.set(h.resource.id, h);
    }
  }

  const resources = [...picked.values()].map((h) => h.resource).slice(0, limit);
  const keptIds = new Set(resources.map((r) => r.id));

  // 实时抓回来的赛事直接进池，并补到还没有资源的任务上——
  // 否则「今天有哪些比赛」这件事在任务卡上看不到
  for (const extra of input.extra ?? []) {
    if (!keptIds.has(extra.id)) {
      resources.push(extra);
      keptIds.add(extra.id);
    }
  }

  return {
    resources,
    links: links
      .map((l) => ({ taskId: l.taskId, resourceIds: l.resourceIds.filter((id) => keptIds.has(id)) }))
      .filter((l) => l.resourceIds.length > 0),
    queries,
  };
}

/**
 * 把两批资源合成一批，按 **url** 去重（库里的优先）。
 *
 * 为什么按 url 而不是 id：id 是模型随手起的，和库里的 id 撞车纯属巧合，
 * 而撞车会让 `validatePlan` 判重复 id 直接把整份计划打回。
 * 同一个网址出现两次才是真正该合并的情况。
 */
export function mergeResources(primary: readonly ResourceInput[], secondary: readonly ResourceInput[]): ResourceInput[] {
  const out: ResourceInput[] = [];
  const byUrl = new Set<string>();
  const ids = new Set<string>();

  for (const r of [...primary, ...secondary]) {
    const url = String(r.url);
    if (byUrl.has(url)) continue;
    // id 撞了但网址不同：改 id 而不是丢掉这条资源
    let id = String(r.id);
    while (ids.has(id)) id = `${id}_2`;
    byUrl.add(url);
    ids.add(id);
    out.push(id === r.id ? r : { ...r, id });
  }
  return out;
}
