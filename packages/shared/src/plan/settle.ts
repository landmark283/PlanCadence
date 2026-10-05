/**
 * 回归补账 —— 学生隔了若干天再打开时，把被时间冲掉的事实对齐。
 *
 * ## 这一层负责算，模型只负责措辞
 *
 * 除了一段叙述文字，这里算出来的**全部是数字和清单**，可复现、可单测。
 * 服务端那条 AI 路径**拿不到计划、只拿到本模块的输出**，所以它在结构上
 * 就不可能把「有 9 项没做」说成「有 3 项没做」。这是刻意的：
 * 数字数错是这一屏唯一不能犯的错，而模型数数不可靠。
 *
 * ## 为什么默认是「都没做」
 *
 * 界面默认假定这段时间的任务**都没做**，让学生只勾出他其实做完的那几项。
 * 理由是三条：
 *  1. 它是**无损**的默认——任务不会丢，也不会被错误记账；
 *  2. 它让**最常见的情况是零次额外操作**：隔了几天回来多数时候就是真的一项没做，
 *     直接点确认就行；
 *  3. 反过来「逐项问做了没」在隔了 5 天、9 项的情况下会变成 9 次问答，
 *     和「简洁的交互」正面冲突。
 *
 * 所以本模块产出的是「**没做的清单**」，不是「全部清单」。
 */
import { z } from 'zod';

import { clonePlan } from './schema.ts';
import type { PlanFile, Task, TaskType } from './schema.ts';
import { addDays, availableMinutes, daysBetween, proposeReschedule } from './engine.ts';

/** 结算区间内本该完成却没打勾的一项 */
export type SettleItem = {
  taskId: string;
  title: string;
  type: TaskType;
  estimateMin: number;
  scheduledFor: string;
  /** 这项挡着几个后续任务（传递闭包，只数还没做完的） */
  blocks: number;
};

export type SettleFacts = {
  from: string;
  to: string;
  daysPassed: number;
  /**
   * 学生原本的目标原话。
   *
   * 放在事实里一起产出，而不是让调用方另外去 plan 上取一次——
   * 叙述要用它，而叙述的输入是从这里派生的（`settleNarrativeInput`）。
   * 让调用方自己拼的话，两处迟早会取到不同的东西（比如计划换了一份）。
   */
  goalStatement: string;
  /** 区间内排期、且已经打勾的项数。用来跟学生说「你其实做完了 3 项」 */
  doneCount: number;
  /** 没做的清单。界面上的主角 */
  pending: SettleItem[];
  /** 目标截止日已经过去 */
  pastGoalDeadline: boolean;
  /** 截止日已过、却还有没做完任务的里程碑 */
  atRiskMilestones: { id: string; title: string }[];
  /** 「压缩到接下来几天」这条路的预览。界面要如实提示会不会超载 */
  compress: {
    horizonDays: number;
    minutes: number;
    capacity: number;
    overloaded: boolean;
    /** 引擎算好的排期，原样交给 `plan.settle` */
    plan: { taskId: string; scheduledFor: string | null }[];
  };
};

/** 还没结束的任务。`skipped` 是「学生主动放弃」，不参与补账 */
function isActive(t: Task): boolean {
  return t.status === 'todo' || t.status === 'doing' || t.status === 'blocked';
}

/**
 * 算这段时间的账。
 *
 * `from` 是上次打开那天，`to` 是今天。区间取 **(from, to]** ——
 * `from` 那天的任务是上次打开时就该看到的，不算这段时间的欠账。
 *
 * `daysPassed < 1`（没隔天，或者调试模式把日期往回拨了）返回 `null`：
 * 没有「这段时间」，就没有账可结。
 */
export function settleFacts(plan: PlanFile, from: string, to: string): SettleFacts | null {
  const daysPassed = daysBetween(from, to);
  if (daysPassed < 1) return null;

  const inWindow = (day: string | null): day is string => day !== null && day > from && day <= to;

  const pendingTasks = plan.tasks.filter(
    (t): t is Task & { scheduledFor: string } => isActive(t) && inWindow(t.scheduledFor),
  );
  const pendingIds = new Set(pendingTasks.map((t) => t.id));

  /**
   * 挡着几个后续任务。
   *
   * 数的是**传递闭包**而不是直接依赖：直接依赖会说「挡着 1 个」，
   * 而那 1 个后面还挂着 3 个——学生看到的数字会严重低估后果。
   * 用 visited 防环：本函数可能在未经 `validatePlan` 的计划上被调用。
   */
  const blocksOf = (id: string): number => {
    const seen = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const t of plan.tasks) {
        if (seen.has(t.id) || !isActive(t)) continue;
        if (t.dependsOn.includes(cur)) {
          seen.add(t.id);
          stack.push(t.id);
        }
      }
    }
    return seen.size - 1;
  };

  const pending: SettleItem[] = pendingTasks
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      type: t.type,
      estimateMin: t.estimateMin,
      scheduledFor: t.scheduledFor,
      blocks: blocksOf(t.id),
    }))
    // 压得越久、挡得越多的排前面——学生先要看到的是后果最大的那几项
    .sort((a, b) => b.blocks - a.blocks || (a.scheduledFor < b.scheduledFor ? -1 : 1));

  const doneCount = plan.tasks.filter((t) => t.status === 'done' && inWindow(t.scheduledFor)).length;

  const atRiskMilestones = plan.milestones
    .filter(
      (m) =>
        m.status !== 'done' &&
        m.status !== 'dropped' &&
        !!m.due &&
        m.due <= to &&
        plan.tasks.some((t) => t.milestoneId === m.id && isActive(t)),
    )
    .map((m) => ({ id: m.id, title: m.title }));

  return {
    from,
    to,
    daysPassed,
    goalStatement: plan.goal.statement,
    doneCount,
    pending,
    pastGoalDeadline: !!plan.goal.deadline && to > plan.goal.deadline,
    atRiskMilestones,
    compress: compressPreview(plan, pendingIds, to, daysPassed),
  };
}

/**
 * 「压缩到接下来几天」会排成什么样，以及会不会超载。
 *
 * 复用引擎的 `proposeReschedule`，不另写一套排期算法——
 * 两套排期算法意味着同一个学生在界面上看到的排期和确认后得到的排期不一样。
 *
 * 天数取 `daysPassed` 并封顶 7 天：丢了 5 天就往接下来的 5 天压，
 * 但丢了 30 天不该压进接下来 30 天——那不是压缩，那是把问题摊平。
 */
function compressPreview(
  plan: PlanFile,
  pendingIds: Set<string>,
  to: string,
  daysPassed: number,
): SettleFacts['compress'] {
  const horizonDays = Math.max(1, Math.min(daysPassed, 7));
  const end = addDays(to, horizonDays - 1);

  const minutes = plan.tasks.filter((t) => pendingIds.has(t.id)).reduce((s, t) => s + t.estimateMin, 0);

  /**
   * 容量。
   *
   * `availableMinutes` 在没有配置可用时段时会算出 0（它按 `availableSlots` 展开），
   * 而 `proposeReschedule` 在同样的情况下退化为一周一排。两边口径必须一致，
   * 否则界面会对着一个其实排得下的方案喊「会超载」。
   */
  const capacity = plan.constraints.availableSlots.length
    ? availableMinutes(plan, to, end)
    : plan.constraints.weeklyMinutes * Math.max(1, Math.ceil(horizonDays / 7));

  const temp = clonePlan(plan);
  for (const t of temp.tasks) {
    if (pendingIds.has(t.id)) {
      t.scheduledFor = null;
      t.pinned = false;
    }
  }
  // `proposeReschedule` 返回的是 `AppliedAdjustment` 联合类型（还可能有改期以外的动作）。
  // 用 flatMap 收窄成排期，而不是断言：`plan.settle` 只认排期这一种
  const placed = proposeReschedule(temp, to, { horizonDays }).flatMap((p) =>
    p.kind === 'reschedule' && pendingIds.has(p.taskId) ? [{ taskId: p.taskId, scheduledFor: p.scheduledFor }] : [],
  );

  return {
    horizonDays,
    minutes,
    capacity,
    overloaded: minutes > capacity,
    plan: placed,
  };
}

/**
 * 本机叙述 —— 服务端不可用时的兜底，也是「引擎算事实」的可见证据。
 *
 * 刻意写得平实。它是这份计划的现状说明，不是劝学。
 */
export function settlePlanText(facts: SettleFacts): string {
  if (!facts.pending.length) return `距上次打开过了 ${facts.daysPassed} 天，这期间的任务都处理过了。`;

  const total = facts.pending.length;
  const blocking = facts.pending.filter((p) => p.blocks > 0);
  const hardest = facts.pending.reduce((max, p) => Math.max(max, daysBetween(p.scheduledFor, facts.to)), 0);

  const bits: string[] = [`距上次打开过了 ${facts.daysPassed} 天。`, `这期间本该完成 ${total} 项，都没打勾。`];
  if (facts.doneCount) bits.push(`不过你也完成了 ${facts.doneCount} 项。`);
  if (blocking.length) bits.push(`其中 ${blocking.length} 项挡着后面的任务，压得最久的一项已经过去 ${hardest} 天。`);
  if (facts.pastGoalDeadline) bits.push('目标截止日已经过去了。');
  if (facts.atRiskMilestones.length) {
    bits.push(`${facts.atRiskMilestones.map((m) => m.title).join('、')} 的截止日已过，但里面还有没做完的事。`);
  }
  return bits.join('');
}

/* ------------------------------------------------------------------ *
 * 交给模型改写的那个载荷
 * ------------------------------------------------------------------ */

/**
 * 送给模型的**全部**内容。
 *
 * 刻意只给这些，不给整份计划：模型看不到 `compress.plan` 之类的内部结构，
 * 也就没有机会基于它编出事实之外的话。定义放在 shared 里而不是服务端，
 * 是为了让客户端和服务端**共用同一个 schema**——两处各写一份形状，
 * 迟早会出现「客户端多发了一个字段、服务端静默丢掉」。
 */
export const SettleNarrativeInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  daysPassed: z.number().int().min(1).max(3650),
  doneCount: z.number().int().min(0),
  /** 没做的清单。只给标题和「压了多久」，不给 id */
  pending: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        scheduledFor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        blocks: z.number().int().min(0),
        estimateMin: z.number().int().min(0),
      }),
    )
    .max(500),
  pastGoalDeadline: z.boolean(),
  atRiskMilestones: z.array(z.string().max(120)).max(50),
  goalStatement: z.string().max(300),
  /** 本机叙述。模型这条路任何环节出问题时原样返回它 */
  localText: z.string().min(1).max(4000),
});
export type SettleNarrativeInput = z.infer<typeof SettleNarrativeInput>;

/** 从事实里取出要交给模型的那一块 */
export function settleNarrativeInput(
  facts: SettleFacts,
  goalStatement: string,
  localText: string,
): SettleNarrativeInput {
  return {
    from: facts.from,
    to: facts.to,
    daysPassed: facts.daysPassed,
    doneCount: facts.doneCount,
    pending: facts.pending.map((p) => ({
      title: p.title,
      scheduledFor: p.scheduledFor,
      blocks: p.blocks,
      estimateMin: p.estimateMin,
    })),
    pastGoalDeadline: facts.pastGoalDeadline,
    atRiskMilestones: facts.atRiskMilestones.map((m) => m.title),
    goalStatement,
    localText,
  };
}

/**
 * 叙述里出现的所有整数。全角数字也认，模型偶尔会写 `９`。
 *
 * **先把日期整段挖掉。** 模型很自然会写「10 月 15 日到 10 月 19 日」，
 * 那些数字是日期的组成部分，不是它自己算出来的计数；不挖掉的话
 * 每一句提到日期的正常叙述都会被判成「编数字」而被退掉，这个功能就形同虚设。
 * 日期写错的风险由界面兜着——真实日期就印在叙述正下方的清单里。
 */
export function numbersIn(text: string): number[] {
  const cleaned = text
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, ' ')
    .replace(/\d{1,2}\s*\/\s*\d{1,2}/g, ' ');

  const out: number[] = [];
  for (const m of cleaned.matchAll(/[0-9０-９]+/g)) {
    const n = Number(m[0].replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10)));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * 模型写的数字必须**全部来自事实**。
 *
 * 这是把「引擎算事实、模型只改措辞」从一句口号变成一个真正的约束：
 * 光在提示词里写「不要改数字」是没有约束力的，模型仍然会把 9 项说成 3 项，
 * 而**数字数错是这一屏唯一不能犯的错**。
 *
 * 做法是白名单：列出所有它有权使用的数字，出现白名单之外的整数就判定为不安全，
 * 调用方退回本机叙述。宁可偶尔退掉一段写得不错的文字，也不要让学生看到
 * 一个编出来的数字——后者会让他对整个系统失去信任，而且他无从发现。
 *
 * 白名单刻意放得比「最少需要」宽一些（比如各种计数都放进去），
 * 因为误杀一段好文字虽然安全，但会让这个功能形同虚设。
 */
export function narrativeNumbersOk(
  text: string,
  input: SettleNarrativeInput,
): { ok: true } | { ok: false; bad: number[] } {
  const blocking = input.pending.filter((p) => p.blocks > 0).length;
  const allowed = new Set<number>([
    input.daysPassed,
    input.doneCount,
    input.pending.length,
    blocking,
    input.atRiskMilestones.length,
    ...input.pending.map((p) => p.blocks),
    ...input.pending.map((p) => p.estimateMin),
  ]);

  const bad = [...new Set(numbersIn(text).filter((n) => !allowed.has(n)))];
  return bad.length ? { ok: false, bad } : { ok: true };
}

