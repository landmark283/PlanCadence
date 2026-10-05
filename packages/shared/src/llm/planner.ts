/**
 * planner：把访谈档案变成一份合法的计划。
 *
 * ## 两条路径，一个出口
 *
 *   · **LLM 路径**：模型按档案生成任务、里程碑、能力点。校验不过时**不重生成整份**，
 *     而是把 `validatePlan` 的具体报错回灌给它做定点修复（最多 2 轮）——
 *     全量重生成会把已经对的部分也一起摇掉，定点修复稳定得多。
 *   · **本地路径** `localDraft`：不依赖任何模型，按档案算出一份结构完整的计划。
 *
 * 本地路径不是"聊胜于无的降级"，它是**地板**：断网、没 Key、模型抽风时，
 * 学生仍然拿得到一份排进自己日程、避开自己考试周的计划。
 * 所以它必须自己就能过 `validatePlan`，这一条有测试盯着。
 *
 * ## 复用 plan/schema 作为唯一真相源
 *
 * `DraftOutput` 直接复用 `Goal` / `Constraints` / `Task` / `Milestone` / `Competence` / `Resource`，
 * 不另立一套"计划草稿格式"。否则模型输出的形状和文件格式会慢慢漂开，
 * 而这类漂移只有在落盘那一刻才暴露。
 */
import { z } from 'zod';

import {
  Competence,
  Constraints,
  Goal,
  Milestone,
  PlanFile,
  Resource,
  SCHEMA_ID,
  Task,
  validatePlan,
  type PlanIssue,
} from '../plan/schema.ts';
import type { LearnerProfile, Weekday } from './interview.ts';
import { attachPlanResources } from '../tools/retrieve.ts';

/* ------------------------------------------------------------------ *
 * LLM 输出契约
 * ------------------------------------------------------------------ */

/**
 * 模型要产出的东西。刻意**不含** id / version / meta / history —— 那些由代码补齐，
 * 不让模型碰（它一碰就会编出重复 id 或者不合法的版本号）。
 */
export const DraftOutput = z.object({
  goal: Goal,
  constraints: Constraints,
  competences: z.array(Competence).max(8).default([]),
  milestones: z.array(Milestone).max(8).default([]),
  tasks: z.array(Task).max(60).default([]),
  resources: z.array(Resource).max(20).default([]),
});
export type DraftOutput = z.infer<typeof DraftOutput>;

/* ------------------------------------------------------------------ *
 * 日期/时间小工具（UTC，避免本地时区把日期算偏一天）
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const WEEKDAY_ORDER: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_BY_INDEX: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function toMs(day: string): number {
  return Date.parse(`${day}T12:00:00Z`);
}
function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return fmtDay(toMs(day) + n * DAY_MS);
}
function daysBetween(from: string, to: string): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}
function weekdayOf(day: string): Weekday {
  return WEEKDAY_BY_INDEX[new Date(toMs(day)).getUTCDay()]!;
}
/** 'HH:mm' + 分钟 → 'HH:mm'。调用方保证结果不跨天 */
function addMinutes(hhmm: string, n: number): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h! * 60 + m! + n;
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
const roundTo5 = (n: number) => Math.max(5, Math.round(n / 5) * 5);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/* ------------------------------------------------------------------ *
 * 本地兜底生成
 * ------------------------------------------------------------------ */

/** 单日时段上限。再长就不该作为一个"学习时段"存在了 */
const MAX_SLOT_MINUTES = 240;
/** 没有截止日时，按多少天的地平线来排 */
const DEFAULT_HORIZON_DAYS = 90;
/** 起步掌握度：按自评水平给一个不同起点 */
const START_MASTERY: Record<NonNullable<LearnerProfile['level']>, number> = {
  beginner: 0.05,
  basic: 0.15,
  intermediate: 0.3,
  advanced: 0.5,
};
/** 时长系数：起点越低，同样的内容需要越多时间 */
const LEVEL_TIME_FACTOR: Record<NonNullable<LearnerProfile['level']>, number> = {
  beginner: 1.25,
  basic: 1.1,
  intermediate: 1,
  advanced: 0.85,
};

/**
 * 一个能力点的任务链。
 *
 * 顺序是刻意固定的：**先看懂 → 再做模板题 → 再做变式 → 限时自测 → 错题复习**。
 * 这条链路本身就是"怎么学一个不熟的知识点"的答案，
 * 比让模型自由发挥更稳定，也更方便学生理解系统为什么这么排。
 */
function topicTaskChain(topic: string, factor: number, perDay: number) {
  const est = (base: number) => roundTo5(Math.min(base * factor, perDay));
  return [
    { title: `通读「${topic}」的核心概念`, type: 'read' as const, estimateMin: est(45) },
    { title: `「${topic}」模板题 3 道`, type: 'practice' as const, estimateMin: est(90) },
    { title: `「${topic}」变式练习 5 道`, type: 'practice' as const, estimateMin: est(90) },
    { title: `「${topic}」限时自测`, type: 'assess' as const, estimateMin: est(60) },
    { title: `复习：「${topic}」错题重做`, type: 'review' as const, estimateMin: est(30) },
  ];
}

/**
 * 按档案算出一份合法的计划草稿。纯函数。
 *
 * 这个函数是产品在**没有模型**时的完整能力：排进你真实可用的时段、
 * 避开你说了不能用的日期、按你自评的水平决定起步难度。
 */
export function localDraft(profile: LearnerProfile, today: string): DraftOutput {
  const topics = profile.weakSpots.length ? profile.weakSpots : ['基础算法'];
  const weekdays = profile.weekdays.length ? [...profile.weekdays].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b)) : (['sat', 'sun'] as Weekday[]);
  const weeklyHours = profile.weeklyHours ?? 5;
  const level = profile.level ?? 'basic';

  // 单日时长 = 周投入 / 可用天数，并卡在合理区间。
  // 这样 weeklyMinutes 与 availableSlots 的总容量**天然一致**——
  // 示例文件里就出现过 600 分钟预算配 420 分钟时段的自相矛盾。
  const perDay = clamp(Math.round((weeklyHours * 60) / weekdays.length), 30, MAX_SLOT_MINUTES);

  const availableSlots = weekdays.map((d) => {
    const weekend = d === 'sat' || d === 'sun';
    const from = weekend ? '09:00' : '19:00';
    return { day: d, from, to: addMinutes(from, perDay) };
  });

  // 截止日在今天或之前就不当成约束用——一个已经过去的截止日排不出任何东西
  const usableDeadline = profile.deadline && profile.deadline > today ? profile.deadline : null;
  const horizonDays = usableDeadline ? daysBetween(today, usableDeadline) : DEFAULT_HORIZON_DAYS;

  const competences = topics.map((t, i) => ({
    id: `c_${i + 1}`,
    name: t,
    target: 0.8,
    current: START_MASTERY[level],
    evidence: [] as string[],
  }));

  const milestones = topics.map((t, i) => {
    const due = usableDeadline
      ? addDays(today, Math.max(7, Math.round((horizonDays * (i + 1)) / topics.length)))
      : null;
    return {
      id: `m_${i + 1}`,
      title: `${t}入门`,
      due: due && usableDeadline && due > usableDeadline ? usableDeadline : due,
      competenceIds: [`c_${i + 1}`],
      status: (i === 0 ? 'active' : 'pending') as 'active' | 'pending',
      criteria: [`能独立做出「${t}」的中等难度题`, `能说清「${t}」的适用场景`],
    };
  });

  // 排期：按可用日往下走，每天有 perDay 的容量；装不下的进待排池
  const capacity = new Map<string, number>();
  const availableDays: string[] = [];
  for (let i = 0; i < Math.max(horizonDays, 14); i++) {
    const d = addDays(today, i);
    if (!weekdays.includes(weekdayOf(d))) continue;
    if (profile.blackouts.some((b) => d >= b.from && d <= b.to)) continue;
    availableDays.push(d);
    capacity.set(d, perDay);
  }

  const factor = LEVEL_TIME_FACTOR[level];
  const tasks: DraftOutput['tasks'] = [];
  let seq = 0;

  topics.forEach((topic, ti) => {
    const chain = topicTaskChain(topic, factor, perDay);
    const ids = chain.map(() => `t_${String(++seq).padStart(2, '0')}`);

    chain.forEach((spec, ci) => {
      const depId = ci > 0 ? ids[ci - 1]! : null;
      const depDay = depId ? (tasks.find((x) => x.id === depId)?.scheduledFor ?? null) : null;

      // 前置任务的后一天才允许开工，否则会出现"同一天先做后面的"
      const earliestIdx = depDay
        ? availableDays.findIndex((d) => d > depDay)
        : 0;

      let placed: string | null = null;
      for (let k = Math.max(0, earliestIdx); k < availableDays.length; k++) {
        const day = availableDays[k]!;
        const left = capacity.get(day) ?? 0;
        if (left >= spec.estimateMin) {
          capacity.set(day, left - spec.estimateMin);
          placed = day;
          break;
        }
      }

      tasks.push({
        id: ids[ci]!,
        title: spec.title,
        milestoneId: `m_${ti + 1}`,
        dependsOn: depId ? [depId] : [],
        estimateMin: spec.estimateMin,
        type: spec.type,
        status: 'todo',
        scheduledFor: placed,
        pinned: false,
        notBefore: null,
        actualMin: null,
        difficulty: null,
        resourceIds: [],
        // 标记由学生自己打，生成时不预设：系统猜不出「这题我错了好几次」这种事，
        // 而猜错一次标记比不打标记更烦人（学生得先删掉再打自己的）
        tags: [],
        notes: placed ? '' : '排不进当前可用时段，先放待排池',
      });
    });
  });

  const successCriteria = [
    ...topics.slice(0, 3).map((t) => `能独立做出「${t}」的中等难度题`),
    '完整参加一次模拟赛',
  ].slice(0, 4);

  const unplaced = tasks.filter((t) => !t.scheduledFor).length;
  void unplaced;

  const draft: DraftOutput = {
    goal: {
      statement: profile.goalStatement ?? '（还没想好具体目标）',
      successCriteria,
      deadline: usableDeadline,
      priority: usableDeadline && daysBetween(today, usableDeadline) <= 120 ? 'high' : 'medium',
    },
    constraints: {
      weeklyMinutes: perDay * weekdays.length,
      availableSlots,
      maxSessionMinutes: clamp(perDay, 30, 120),
      blackouts: profile.blackouts,
    },
    competences,
    milestones,
    tasks,
    resources: [],
  };

  // 本地路径原来这里写 `resources: []`，理由是不编 URL。那个理由仍然成立，
  // 但现在有了一条不编 URL 也能给出资源的路：工具层从**内置资料库**里取，
  // 每条的网址都人工核过。所以断网时资源面板也不再是空的。
  return withToolResources(draft, profile).draft;
}

/* ------------------------------------------------------------------ *
 * 工具调用：给草稿挂上真实资料
 * ------------------------------------------------------------------ */

export type ToolAttachResult = {
  draft: DraftOutput;
  /** 模型自己塞进 `resources` 的条数——会被丢掉，所以要说出来，不能悄悄删 */
  droppedModelResources: number;
};

/**
 * 把检索到的资料挂进草稿，并写回任务的 `resourceIds`。
 *
 * ## 为什么模型给的 `resources` 一律丢掉
 *
 * 提示词里写了「不要编造网址」，但**提示词不是强制**——这是这个项目反复
 * 吃过的亏（学生原话被"润色"掉那次就是）。而 `Resource.url` 是学生要真的
 * 点开的东西，一条 404 比少一条资源伤害大得多。
 * 所以资源这块**完全由工具层拥有**：存在哪些、挂给谁，都不经过模型。
 *
 * 丢掉多少条会作为 `droppedModelResources` 返回，调用方要把它写进给学生的说明里。
 * 悄悄删掉模型产出的东西，和模型悄悄改掉学生的话是同一类错误。
 *
 * ## `extra` 是给实时抓取留的口子
 *
 * 服务端从网上拉回来的赛事日程从这里进来。抓取失败时传空数组，
 * 结果就退化成纯离线的那一套——**有网没网都能跑**，区别只在 `source` 字段。
 */
export function withToolResources(
  draft: DraftOutput,
  profile: LearnerProfile,
  extra?: readonly Resource[],
): ToolAttachResult {
  const attached = attachPlanResources({
    tasks: draft.tasks.map((t) => ({ id: t.id, title: t.title })),
    profile: {
      weakSpots: profile.weakSpots,
      level: profile.level ?? null,
      goalStatement: profile.goalStatement ?? null,
    },
    extra,
  });

  const byTask = new Map(attached.links.map((l) => [l.taskId, l.resourceIds]));

  return {
    droppedModelResources: draft.resources.length,
    draft: {
      ...draft,
      resources: attached.resources,
      tasks: draft.tasks.map((t) => {
        const add = byTask.get(t.id);
        // 没有命中时也要清空：`resourceIds` 若还留着模型的 id，
        // 那些资源已经被丢掉，`validatePlan` 会判成悬空引用
        if (!add?.length) return { ...t, resourceIds: [] };
        return { ...t, resourceIds: [...new Set(add)] };
      }),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 组装成计划文件
 * ------------------------------------------------------------------ */

export type AssembleOptions = {
  /** 计划 id。调用方给，避免这里读时钟或随机数 */
  id: string;
  /** 生成时刻（ISO，本地时区字面量） */
  now: string;
  title: string;
  /**
   * 学生档案。用于把**学生亲口说过的事实**强制写回，不经过模型。
   *
   * 实测过：模型会把学生原话「蓝桥杯省赛，目标是省一」"润色"成
   * 一段漂亮的摘要（"用每周一 1 小时的固定时段冲刺……练到能稳定拿分"）。
   * 读起来更专业，但复盘页要原样回显的就是那句原话——
   * 那是学生三个月后还会回来看的东西，被改写掉就失去了意义。
   *
   * 这类不变量**由代码强制**，不靠提示词自觉：提示词会被模型的表达欲盖过去。
   */
  profile?: LearnerProfile;
};

/**
 * 把草稿补全成一份完整的 `PlanFile` 并校验。
 *
 * 失败时返回 issues 而不是抛异常：调用方要用这些具体报错去让模型做定点修复。
 */
export function assemblePlan(
  draft: DraftOutput,
  opts: AssembleOptions,
): { ok: true; plan: PlanFile; issues: PlanIssue[] } | { ok: false; issues: PlanIssue[]; error: string } {
  const p = opts.profile;

  const goal = {
    ...draft.goal,
    // 目标原话与截止日是学生说的，不由模型改写
    statement: p?.goalStatement ?? draft.goal.statement,
    deadline: p?.deadline ?? draft.goal.deadline,
  };

  const constraints = {
    ...draft.constraints,
    // 学生明确说了不能用的日期，必须原样保留。
    // 模型漏掉或"顺便"改掉它，就是在替学生做他明确反对过的安排。
    blackouts: p?.blackouts.length ? p.blackouts : draft.constraints.blackouts,
  };

  let plan: PlanFile;
  try {
    plan = PlanFile.parse({
      schema: SCHEMA_ID,
      id: opts.id,
      version: 1,
      meta: { title: opts.title, created: opts.now, updated: opts.now, origin: 'onboarding' },
      goal,
      constraints,
      competences: draft.competences,
      milestones: draft.milestones,
      tasks: draft.tasks,
      resources: draft.resources,
      reviews: [],
      history: [{ at: opts.now, cmd: 'plan.create', summary: '由访谈生成初版计划（v1）' }],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      issues: [{ level: 'error', path: 'plan', message: msg.slice(0, 400) }],
      error: msg,
    };
  }

  const issues = validatePlan(plan);
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) return { ok: false, issues, error: errors.map((i) => `${i.path}: ${i.message}`).join('；') };
  return { ok: true, plan, issues };
}

/** 一句话摘要，用于生成后给学生看。不要报内部 id */
export function describePlanDraft(plan: PlanFile): string {
  const scheduled = plan.tasks.filter((t) => t.scheduledFor).length;
  const backlog = plan.tasks.length - scheduled;
  const first = plan.tasks
    .map((t) => t.scheduledFor)
    .filter((d): d is string => Boolean(d))
    .sort()[0];
  const last = plan.tasks
    .map((t) => t.scheduledFor)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);

  const bits = [`${plan.tasks.length} 个任务`];
  if (plan.competences.length) bits.push(`覆盖 ${plan.competences.length} 个能力点`);
  if (first && last) bits.push(`${first} 起排到 ${last}`);
  if (backlog) bits.push(`${backlog} 个进了待排池`);
  return bits.join(' · ');
}

/* ------------------------------------------------------------------ *
 * LLM 路径
 * ------------------------------------------------------------------ */

const SYSTEM = `你是一个学习规划助手，用简体中文工作。你的服务对象是中国的大学生，
他们通常在为算法竞赛、专业课考试或自学编程做准备。

根据已经了解到的学生情况，生成一份可执行的学习计划草稿。

严格遵守：
1. 只输出 JSON，不要 markdown 围栏，不要任何解释文字。
2. 时间段必须落在学生自述可用的星期里；不要占用他说的不可用日期。
3. 所有 id 必须是小写字母开头、只含小写字母/数字/下划线的短标识；全局唯一。
4. dependsOn / milestoneId / competenceIds / resourceIds 引用的 id 必须真实存在。
5. scheduledFor 必须是 YYYY-MM-DD，或 null（表示放进待排池）；不要排到过去的日期。
6. 任务的 estimateMin 是分钟数，必须是正整数。单个任务不要超过 240 分钟。
7. 每天排的总时长不要超过 weeklyMinutes 摊到当天的量。
8. 学习顺序要符合认知规律：先看懂概念，再做模板题，再做变式，然后自测，最后复习错题。
9. 全部用简体中文。任务标题要具体到"做什么、做多少"，不要写"学习动态规划"这种空话。
10. 不要编造网址。没有把握的资源就不要放进 resources。
11. **任务总数控制在 8–16 个**。这是给一个人排的周计划，不是课程大纲；
    条目过多既拖慢生成，也会让学生第一周就放弃。
    如果学生每周可投入时间少于 5 小时，进一步压到 6–10 个——
    一小时一周的人拿到 16 条任务，只会直接关掉这个 App。
12. constraints.weeklyMinutes 必须等于 availableSlots 里各时段分钟数之和——
    两者对不上的计划，排出来的时长是假的。

输出格式（**tasks 里只写这些字段就够了**，其余字段系统会补默认值）：
{"goal":{"statement":"...","successCriteria":["..."],"deadline":"2027-04-11","priority":"high"},
 "constraints":{"weeklyMinutes":420,"availableSlots":[{"day":"mon","from":"19:00","to":"21:00"}],"maxSessionMinutes":90,"blackouts":[]},
 "competences":[{"id":"c_1","name":"动态规划","target":0.8,"current":0.15}],
 "milestones":[{"id":"m_1","title":"动态规划入门","due":"2026-12-01","competenceIds":["c_1"],"status":"active","criteria":["..."]}],
 "tasks":[{"id":"t_01","title":"通读动态规划核心概念","milestoneId":"m_1","dependsOn":[],"estimateMin":45,"type":"read","scheduledFor":"2026-10-21"}],
 "resources":[]}

可以省略的字段：status / pinned / notBefore / actualMin / difficulty / resourceIds / notes
（以及 competences 的 evidence、milestones 的 criteria、constraints 的 blackouts）。
**省掉它们能让回复快很多**，请不要为了"完整"而全部写出来。`;

export function buildPlannerMessages(
  profile: LearnerProfile,
  today: string,
  previous?: { errors: string[] },
): { system: string; user: string } {
  const lines: string[] = [`今天是 ${today}。`, '', '【学生情况】'];
  lines.push(`目标原话：${profile.goalStatement ?? '（没填）'}`);
  lines.push(`截止日：${profile.deadline ?? '（没填，请按 3 个月安排）'}`);
  lines.push(`当前水平：${profile.level ?? '（没填）'}`);
  lines.push(`每周可投入：${profile.weeklyHours !== null ? `${profile.weeklyHours} 小时` : '（没填，按 5 小时安排）'}`);
  lines.push(`方便的学习日：${profile.weekdays.length ? profile.weekdays.join(', ') : '（没填，按周六周日安排）'}`);
  lines.push(`自述薄弱：${profile.weakSpots.length ? profile.weakSpots.join('、') : '（没填）'}`);
  if (profile.blackouts.length) {
    lines.push(`明确不能用的日期：${profile.blackouts.map((b) => `${b.from}~${b.to}${b.reason ? `（${b.reason}）` : ''}`).join('、')}`);
  }

  if (previous?.errors.length) {
    lines.push(
      '',
      '【上一版草稿有这些问题，请只修这些，其余部分保持不变】',
      ...previous.errors.map((e, i) => `${i + 1}. ${e}`),
    );
  }

  return { system: SYSTEM, user: lines.join('\n') };
}

/** 从模型的 JSON 文本解析出草稿。解析失败返回可读原因，供修复轮使用 */
export function parseDraftOutput(json: unknown): { ok: true; draft: DraftOutput } | { ok: false; error: string } {
  const r = DraftOutput.safeParse(json);
  if (r.success) return { ok: true, draft: r.data };
  const first = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`);
  return { ok: false, error: `草稿结构不合法：${first.join('；')}` };
}
