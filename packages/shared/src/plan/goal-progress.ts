/**
 * 把「每条线现在什么情况」算出来，供界面画目标卡片。
 *
 * ## 为什么这一层在 `shared` 而不是在那一屏里
 *
 * 「这条线做了几项、还剩多少小时、掌握度到哪了、来不来得及」——
 * 这些数字会**同时在好几处出现**（今日页的提醒、目标屏的卡片、复盘页的方向）。
 * 各处各写一遍的话，同一个学生在同一天会看到两个不同的剩余小时数，
 * 而「哪条线来不及」恰恰是这一屏唯一不能错的判断。
 * 所以算在纯函数里，有测试盯着，界面只负责画。
 *
 * ## 格式没有任何改动
 *
 * 卡片要显示的每一项都来自现有字段：`milestones[].{title,due,criteria,status}`、
 * `tasks[].{milestoneId,scheduledFor,estimateMin,actualMin,status}`、
 * `competences[].{name,current,target,evidence}`，加上引擎的 `milestoneRisk`。
 *
 * 唯一**没有**的东西是「判据逐条勾上了没」——`criteria` 是字符串数组，
 * 没有勾选状态。所以这一版判据只作为文本展示（`criteria` 原样带出来），
 * 要能勾就得给格式加字段，那件事得先问过再说。
 */
import type { Drift } from './engine.ts';
import { daysBetween } from './engine.ts';
import type { MilestoneStatus, PlanFile, Task } from './schema.ts';

/** 一个能力点在这条线上的样子 */
export type GoalCompetence = {
  id: string;
  name: string;
  /** 当前估计掌握度 0..1 */
  current: number;
  target: number;
  /** 有没有证据撑着这个估计。没有时界面不该显示一个像成绩的百分数 */
  hasEvidence: boolean;
};

export type GoalProgress = {
  milestoneId: string;
  title: string;
  status: MilestoneStatus;
  due: string | null;
  /**
   * 距截止还有几天。没有截止日时 null；**已过期是负数**。
   *
   * 刻意不在引擎里夹到 0：界面上「还剩 0 天」和「已经过期 3 天」是两件事，
   * 而后者才是需要学生动作的那一种。
   */
  daysLeft: number | null;
  /** 有截止日、还没收尾、而且已经过了截止日 */
  overdue: boolean;
  criteria: string[];
  competences: GoalCompetence[];

  /** 属于这条线的任务总数（含已完成的） */
  totalTasks: number;
  doneTasks: number;
  /**
   * 还没排进任何一天、还在待排池里的任务数。
   *
   * 单独给一个数，是因为「排期 10月25日」这句话**会骗人**：
   * 一条线有两项任务、只有一项排上了时，那句话读起来像「这条线排好了」，
   * 而实际上还有一项悬着。学生要么在这里看见它，要么永远不知道。
   */
  unscheduledTasks: number;
  /** 已投入分钟：完成的任务按实际用时算，没填就退回预估 */
  spentMin: number;
  /** 还没做完的任务合计预估分钟 */
  remainingMin: number;
  /** 这条线的任务最早排在哪天（null = 一项都没排） */
  firstScheduled: string | null;
  /** 最晚排在哪天 */
  lastScheduled: string | null;

  /** 引擎报的「来不及」还差多少分钟；没有风险时 null */
  shortfallMin: number | null;
  atRisk: boolean;
};

const SETTLED: readonly MilestoneStatus[] = ['done', 'dropped'];

/**
 * 每条线的进度，按「学生该先看哪条」排好序。
 *
 * 顺序是刻意的：**还在跑的在前，按截止日从近到远；已收尾的在后。**
 * 学生打开这一屏问的是「哪条线还在跑、哪条紧」，而不是「我历史上立过几条线」。
 * 没有截止日的排在带截止日的后面——不是不重要，是没法排序，而混在一起会让
 * 最近的那条沉下去。
 */
export function goalProgress(plan: PlanFile, today: string, drift: readonly Drift[] = []): GoalProgress[] {
  const riskById = new Map<string, number>();
  for (const d of drift) {
    if (d.kind === 'milestoneRisk') riskById.set(d.milestoneId, d.shortfallMin);
  }
  const compById = new Map(plan.competences.map((c) => [c.id, c]));

  const byGoal = new Map<string, Task[]>();
  for (const t of plan.tasks) {
    if (!t.milestoneId) continue;
    const bucket = byGoal.get(t.milestoneId);
    if (bucket) bucket.push(t);
    else byGoal.set(t.milestoneId, [t]);
  }

  const rows = plan.milestones.map((m): GoalProgress => {
    const tasks = byGoal.get(m.id) ?? [];
    const done = tasks.filter((t) => t.status === 'done');
    const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'skipped');
    const days = tasks.map((t) => t.scheduledFor).filter((d): d is string => Boolean(d)).sort();

    const daysLeft = m.due ? daysBetween(today, m.due) : null;
    const shortfallMin = riskById.get(m.id) ?? null;

    return {
      milestoneId: m.id,
      title: m.title,
      status: m.status,
      due: m.due,
      daysLeft,
      overdue: Boolean(m.due && daysLeft !== null && daysLeft < 0 && !SETTLED.includes(m.status)),
      criteria: m.criteria,
      competences: m.competenceIds.flatMap((id) => {
        const c = compById.get(id);
        return c
          ? [{ id: c.id, name: c.name, current: c.current, target: c.target, hasEvidence: c.evidence.length > 0 }]
          : [];
      }),
      totalTasks: tasks.length,
      doneTasks: done.length,
      unscheduledTasks: open.filter((t) => !t.scheduledFor).length,
      spentMin: done.reduce((s, t) => s + (t.actualMin ?? t.estimateMin), 0),
      remainingMin: open.reduce((s, t) => s + t.estimateMin, 0),
      firstScheduled: days[0] ?? null,
      lastScheduled: days[days.length - 1] ?? null,
      shortfallMin,
      atRisk: shortfallMin !== null,
    };
  });

  const rank = (g: GoalProgress) => (SETTLED.includes(g.status) ? 1 : 0);
  return rows.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });
}

/**
 * 不属于任何一条线的任务。
 *
 * 这不是异常状态：`addTask` 造出来的任务（「跟 AI 说说」顺手加的那一项）
 * 本来就没有 `milestoneId`。目标屏要**明确提一句**它们的存在——
 * 否则学生在目标卡片上把每条线的任务数加起来，会发现比计划里的总数少，
 * 而少掉的那些在这个屏上无迹可寻。
 */
export function unassignedTasks(plan: PlanFile): Task[] {
  const ids = new Set(plan.milestones.map((m) => m.id));
  return plan.tasks.filter((t) => !t.milestoneId || !ids.has(t.milestoneId));
}

/**
 * 一条线的一句话进度。
 *
 * 抽出来是为了让**提醒、卡片、复盘方向**三处对同一条线说同一句话——
 * 同一个学生在同一天看到「还剩约 6 小时」和「还有 6 小时没做」两种说法，
 * 是最容易被一眼看穿的拼装感（这条规矩见 `docs/技术方案.md` §9.3）。
 *
 * 只描述**事实**，不给建议——建议是复盘那一层的事。
 */
export function describeGoal(g: GoalProgress): string {
  const bits: string[] = [];
  if (g.totalTasks) bits.push(`${g.doneTasks}/${g.totalTasks} 项`);
  if (g.remainingMin > 0) bits.push(`还剩约 ${Math.round(g.remainingMin / 60)} 小时`);
  if (g.due) {
    if (g.daysLeft === null) bits.push(`截止 ${g.due}`);
    else if (g.daysLeft < 0) bits.push(`已过期 ${-g.daysLeft} 天`);
    else if (g.daysLeft === 0) bits.push('今天截止');
    else bits.push(`还剩 ${g.daysLeft} 天`);
  }
  return bits.join(' · ');
}
