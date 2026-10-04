/**
 * 自适应引擎（规则层）—— 全部是纯函数。
 *
 * 核心原则：**规则层负责算，LLM 负责解释和提议。**
 * 时长超没超、依赖断没断、里程碑来不来得及，全部由这里用代码算出来，
 * 可复现、可解释、不幻觉。LLM 只把结果翻译成人话并给出选项（见 tech doc §7）。
 *
 * 纯函数约束：不读时钟、不读网络、不读随机数。所有「今天」由调用方以 today 传入。
 */
import { isoWeekKey } from './schema.ts';
import type { PlanFile, Task } from './schema.ts';
import type { AppliedAdjustment } from './commands.ts';

const DAY_MS = 86_400_000;

/** 单次调整幅度上限：一次最多改动 30% 的**已有排期**任务 */
export const MAX_ADJUSTMENT_RATIO = 0.3;
/** 难度爬升上限：单周掌握度目标提升不超过 0.2 */
export const MAX_DIFFICULTY_STEP_PER_WEEK = 0.2;
/** 进行中任务超过这么多天没动静就算卡住 */
export const STALL_DAYS = 5;
/** 实际耗时 / 预估 超过这个倍数算预估偏低 */
export const OVERRUN_RATIO = 1.3;
/** 低于这个倍数算预估偏高（「学得快」信号） */
export const UNDERRUN_RATIO = 0.6;

/* ------------------------------------------------------------------ *
 * 日期工具（全部按 UTC 处理，避免本地时区把日期算偏一天）
 * ------------------------------------------------------------------ */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type Weekday = (typeof WEEKDAYS)[number];

function parseDay(s: string): number {
  return Date.parse(`${s}T00:00:00Z`);
}
function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
export function addDays(day: string, n: number): string {
  return fmtDay(parseDay(day) + n * DAY_MS);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS);
}
function weekdayOf(day: string): Weekday {
  return WEEKDAYS[new Date(parseDay(day)).getUTCDay()]!;
}
function minutesBetween(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  return Math.max(0, th! * 60 + tm! - (fh! * 60 + fm!));
}

function isBlackout(plan: PlanFile, day: string): boolean {
  return plan.constraints.blackouts.some((b) => day >= b.from && day <= b.to);
}

/** 区间内可用学习分钟数（按 availableSlots 展开，扣除 blackout，再受周预算封顶） */
export function availableMinutes(plan: PlanFile, from: string, to: string): number {
  const slots = plan.constraints.availableSlots;
  if (from > to) return 0;
  let total = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (isBlackout(plan, d)) continue;
    const wd = weekdayOf(d);
    for (const s of slots) if (s.day === wd) total += minutesBetween(s.from, s.to);
  }
  const weeks = Math.max(1, Math.ceil((daysBetween(from, to) + 1) / 7));
  return Math.min(total, plan.constraints.weeklyMinutes * weeks);
}

/* ------------------------------------------------------------------ *
 * 6.1 偏差检测
 * ------------------------------------------------------------------ */

export type Drift =
  | { kind: 'overdue'; taskId: string; days: number }
  | { kind: 'overrun'; taskId: string; ratio: number }
  | { kind: 'underrun'; taskId: string; ratio: number }
  | { kind: 'stalled'; taskId: string; days: number }
  | { kind: 'chainBlocked'; taskId: string; blockedBy: string }
  | { kind: 'milestoneRisk'; milestoneId: string; shortfallMin: number; capacityMin: number }
  | { kind: 'budgetOver'; week: string; plannedMin: number; capacityMin: number };

export function detectDrift(plan: PlanFile, today: string): Drift[] {
  const out: Drift[] = [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const active = (t: Task) => t.status === 'todo' || t.status === 'doing' || t.status === 'blocked';

  for (const t of plan.tasks) {
    if (active(t) && t.scheduledFor && t.scheduledFor < today) {
      out.push({ kind: 'overdue', taskId: t.id, days: daysBetween(t.scheduledFor, today) });
    }
    if (t.status === 'done' && t.actualMin != null) {
      const ratio = t.actualMin / t.estimateMin;
      if (ratio > OVERRUN_RATIO) out.push({ kind: 'overrun', taskId: t.id, ratio: Number(ratio.toFixed(2)) });
      else if (ratio < UNDERRUN_RATIO) out.push({ kind: 'underrun', taskId: t.id, ratio: Number(ratio.toFixed(2)) });
    }
    if (t.status === 'doing' && t.scheduledFor && daysBetween(t.scheduledFor, today) >= STALL_DAYS) {
      out.push({ kind: 'stalled', taskId: t.id, days: daysBetween(t.scheduledFor, today) });
    }
    if (active(t)) {
      for (const d of t.dependsOn) {
        const dep = byId.get(d);
        if (dep && dep.status !== 'done' && dep.scheduledFor && dep.scheduledFor < today) {
          out.push({ kind: 'chainBlocked', taskId: t.id, blockedBy: d });
        }
      }
    }
  }

  // 周预算
  const byWeek = new Map<string, number>();
  for (const t of plan.tasks) {
    if (!active(t) || !t.scheduledFor) continue;
    const w = isoWeekKey(t.scheduledFor);
    byWeek.set(w, (byWeek.get(w) ?? 0) + t.estimateMin);
  }
  for (const [week, planned] of byWeek) {
    if (planned > plan.constraints.weeklyMinutes) {
      out.push({ kind: 'budgetOver', week, plannedMin: planned, capacityMin: plan.constraints.weeklyMinutes });
    }
  }

  // 里程碑风险：剩余任务总时长 vs 到 due 的可用时长
  for (const m of plan.milestones) {
    if (m.status === 'done' || m.status === 'dropped' || !m.due) continue;
    const remaining = plan.tasks
      .filter((t) => t.milestoneId === m.id && active(t))
      .reduce((s, t) => s + t.estimateMin, 0);
    if (!remaining) continue;
    const horizonEnd = m.due < today ? today : m.due;
    const capacity = availableMinutes(plan, today, horizonEnd);
    if (remaining > capacity) {
      out.push({ kind: 'milestoneRisk', milestoneId: m.id, shortfallMin: remaining - capacity, capacityMin: capacity });
    }
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * 6.2 重排
 * ------------------------------------------------------------------ */

function topoOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 0 | 1 | 2>();
  const out: Task[] = [];
  const visit = (t: Task): void => {
    const s = state.get(t.id) ?? 0;
    if (s !== 0) return; // 已访问或正在访问（环，交给 validatePlan 报错）
    state.set(t.id, 1);
    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      if (dep) visit(dep);
    }
    state.set(t.id, 2);
    out.push(t);
  };
  for (const t of tasks) visit(t);
  return out;
}

export type RescheduleOptions = {
  horizonDays?: number;
  maxAdjustmentRatio?: number;
};

/**
 * 生成重排建议。**只生成建议，不改动计划** —— 由学生在协商页逐条接受后，
 * 才通过 `plan.applyAdjustments` 写回。
 *
 * `pinned: true` 的任务（学生手动排定的）不参与重排，但它们占用的时间会被预留，
 * 可动任务只能在剩余容量里安排。
 */
export function proposeReschedule(plan: PlanFile, today: string, opts: RescheduleOptions = {}): AppliedAdjustment[] {
  const horizonDays = opts.horizonDays ?? 84;
  const maxRatio = opts.maxAdjustmentRatio ?? MAX_ADJUSTMENT_RATIO;

  const active = plan.tasks.filter((t) => t.status === 'todo' || t.status === 'doing' || t.status === 'blocked');
  // 学生手动锁定的任务不参与自动重排——引擎只能在它们周围填时间。
  // 否则会把学生刻意避开考试周的安排改回去，直接摧毁「协商」这个卖点。
  const movable = active.filter((t) => !t.pinned);
  if (!movable.length) return [];

  const msDue = new Map(plan.milestones.map((m) => [m.id, m.due]));
  const dueOf = (t: Task) => (t.milestoneId ? (msDue.get(t.milestoneId) ?? '9999-12-31') : '9999-12-31');

  // 拓扑序保证前置先排；同层内按里程碑截止日排（Array.sort 是稳定的，不打乱拓扑序）
  const ordered = topoOrder(movable).sort((a, b) => {
    const da = dueOf(a) ?? '9999-12-31';
    const db = dueOf(b) ?? '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  // 展开每日容量
  const days: { date: string; left: number }[] = [];
  for (let i = 0; i < horizonDays; i++) {
    const date = addDays(today, i);
    let m = 0;
    if (!isBlackout(plan, date)) {
      const wd = weekdayOf(date);
      for (const s of plan.constraints.availableSlots) if (s.day === wd) m += minutesBetween(s.from, s.to);
    }
    days.push({ date, left: m });
  }
  // 没有配置可用时段时，退化为一周一排，避免算出「哪都排不下」而清空所有排期
  if (!plan.constraints.availableSlots.length) {
    for (let i = 0; i < days.length; i += 7) days[i]!.left = plan.constraints.weeklyMinutes;
  }

  // 先把锁定任务占用的时间扣掉，再在剩余容量里安排可动任务
  for (const t of active) {
    if (!t.pinned || !t.scheduledFor) continue;
    const day = days.find((d) => d.date === t.scheduledFor);
    if (day) day.left = Math.max(0, day.left - t.estimateMin);
  }

  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const target = new Map<string, string | null>();

  for (const t of ordered) {
    // 依赖完成之后的第一个可用日。
    // 注意必须无条件取 max(earliest, dep日期+1)：写成 `dep日期 > earliest ? +1 : 不变`
    // 会在「依赖恰好排在今天」时把后置任务排到同一天（曾被测试抓到）。
    let earliest = today;

    // 学生指定的「最早可安排日」——「这门等考完再说」这类意图。
    // 它过去只存在于 notes 的自由文本里，规则层读不懂，于是被无视。
    if (t.notBefore && t.notBefore > earliest) earliest = t.notBefore;

    for (const d of t.dependsOn) {
      const dep = byId.get(d);
      const at = target.get(d) ?? dep?.scheduledFor ?? null;
      if (at) {
        const after = addDays(at, 1);
        if (after > earliest) earliest = after;
      }
    }
    let placed: string | null = null;
    for (const day of days) {
      if (day.date < earliest) continue;
      if (day.left >= t.estimateMin) {
        day.left -= t.estimateMin;
        placed = day.date;
        break;
      }
    }
    target.set(t.id, placed);
  }

  // 计算差异，并按紧急度排序后受护栏截断
  type Change = { task: Task; to: string | null; score: number; reason: string };
  const changes: Change[] = [];
  for (const t of ordered) {
    const to = target.get(t.id) ?? null;
    if (to === t.scheduledFor) continue;
    const overdueDays = t.scheduledFor && t.scheduledFor < today ? daysBetween(t.scheduledFor, today) : 0;
    const score = overdueDays * 100 + (t.status === 'doing' ? 50 : 0) + (to === null ? 10 : 0);

    // 理由必须具体。协商页上这句是学生判断「系统到底懂不懂我」的唯一依据，
    // 写成笼统的「为腾出容量重排」等于没说；把首次排期称作「重排」更是错的。
    let reason: string;
    if (to === null) {
      reason = `未来 ${horizonDays} 天内可用时段不足，排不下，先移回待排池`;
    } else if (t.scheduledFor === null) {
      reason = `纳入排期：${to}（此前未安排时间）`;
    } else {
      const dir = to > t.scheduledFor ? '顺延' : '提前';
      const cause =
        overdueDays > 0 ? `原定 ${t.scheduledFor} 已过期 ${overdueDays} 天` : '按里程碑截止日与可用时段重新填充';
      reason = `从 ${t.scheduledFor} ${dir}到 ${to}（${cause}）`;
    }
    changes.push({ task: t, to, score, reason });
  }
  changes.sort((a, b) => b.score - a.score);

  // 护栏只约束「已有排期被改动」的任务：把一份排期整体挪走会让学生失去掌控感。
  // 首次排期（scheduledFor 原本为 null）不算折腾，必须全部落地——
  // 否则任务少时 cap 会退化成 1，连「前置排在后面」这种基本要求都满足不了。
  const firstTime = changes.filter((c) => c.task.scheduledFor === null);
  const reshuffled = changes.filter((c) => c.task.scheduledFor !== null);
  const cap = Math.max(1, Math.ceil(movable.length * maxRatio));
  const kept = [...firstTime, ...reshuffled.slice(0, cap)];

  return kept.map(
    (c): AppliedAdjustment => ({ kind: 'reschedule', taskId: c.task.id, scheduledFor: c.to, reason: c.reason })
  );
}

/* ------------------------------------------------------------------ *
 * 6.3 掌握度更新
 * ------------------------------------------------------------------ */

/** 完成一个任务带来的掌握度增量（0..1 之前，还需经 nextMastery 收敛） */
export function masteryGain(task: Task): number {
  const difficulty = task.difficulty ?? 0.5;
  const actual = task.actualMin ?? task.estimateMin;
  const timeFactor = Math.max(0.5, Math.min(1.5, actual / task.estimateMin));
  const typeWeight = task.type === 'review' ? 0.5 : task.type === 'assess' ? 1.2 : 1;
  return 0.15 * (1 - difficulty) * timeFactor * typeWeight;
}

/**
 * 边际递减：越接近掌握，同样努力涨得越少。
 * 跳过的任务温和衰减，避免误伤（学生跳过不等于不会）。
 */
export function nextMastery(current: number, gain: number): number {
  const next = current + gain * (1 - current);
  return Math.max(0, Math.min(1, next));
}

export type MasteryUpdate = { competenceId: string; from: number; to: number; evidenceTaskId: string };

/** 从已完成任务推出应写回的掌握度（不含复习型任务，它们只巩固不新增证据） */
export function proposeMasteryUpdates(plan: PlanFile): MasteryUpdate[] {
  const out: MasteryUpdate[] = [];
  const byId = new Map(plan.competences.map((c) => [c.id, { ...c }]));

  const relevant = plan.tasks
    .filter((t) => t.status === 'done' && t.difficulty != null && t.type !== 'review')
    .sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''));

  for (const t of relevant) {
    const m = plan.milestones.find((x) => x.id === t.milestoneId);
    if (!m) continue;
    for (const cid of m.competenceIds) {
      const c = byId.get(cid);
      if (!c || c.evidence.includes(t.id)) continue; // 已计入证据，不重复累加
      const from = c.current;
      c.current = nextMastery(c.current, masteryGain(t));
      c.evidence = [...c.evidence, t.id];
      out.push({ competenceId: cid, from, to: Number(c.current.toFixed(4)), evidenceTaskId: t.id });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6.4 目标协商
 * ------------------------------------------------------------------ */

export type GoalOptionKind =
  | 'deepen'
  | 'accelerate'
  | 'contest'
  | 'extendDeadline'
  | 'narrowScope'
  | 'lowerWeekly'
  | 'splitMilestone';

export type GoalOption = {
  kind: GoalOptionKind;
  title: string;
  /** 为什么提议（触发依据，带具体数字） */
  rationale: string;
  /** 对总时长的影响 */
  impact: string;
  /** 预计后果 */
  consequences: string;
};

/**
 * 只生成**选项**，绝不自动改目标。
 *
 * 产品上刻意避免「发现你学得快，所以给你加了更多内容」这种表述——
 * 那在演示里会被理解成压榨。正确做法是把决定权交回学生。
 */
export function proposeGoalOptions(plan: PlanFile, drift: Drift[]): GoalOption[] {
  const opts: GoalOption[] = [];
  const recent = plan.reviews.slice(-2);

  if (recent.length >= 2) {
    const rates = recent.map((r) => (r.plannedTasks ? r.completedTasks / r.plannedTasks : 0));
    const loads = recent.map((r) => r.loadFeedback ?? 0.5);
    const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    const avgLoad = loads.reduce((a, b) => a + b, 0) / loads.length;

    if (avgRate > 0.9 && avgLoad < 0.4) {
      const pct = Math.round(avgRate * 100);
      opts.push({
        kind: 'deepen',
        title: '加深内容难度',
        rationale: `最近两期完成率 ${pct}%，自评负载偏轻（${avgLoad.toFixed(2)}）`,
        impact: `每周投入不变，但单个任务的难度提升不超过 ${MAX_DIFFICULTY_STEP_PER_WEEK}/周`,
        consequences: '进度更有挑战，但可能让完成率下降——如果两周内完成率跌破 60%，建议改回当前难度',
      });
      opts.push({
        kind: 'accelerate',
        title: '加快进度，提前触碰里程碑',
        rationale: `连续两期超额完成，当前排期偏保守`,
        impact: '总时长可缩短 10–20%',
        consequences: '更早进入下一阶段，但缓冲变薄，遇到意外（考试周、生病）时更容易断档',
      });
      opts.push({
        kind: 'contest',
        title: '把目标转向一场相关竞赛',
        rationale: '当前进度领先于原计划，有余量承接一个有明确截止日的目标',
        impact: '不额外增加每周时长，但会占用一部分「加深内容」的份额',
        consequences: '有外部截止日会提升执行力；但竞赛失利可能影响信心',
      });
    }

    if (avgRate < 0.5 || avgLoad > 0.75) {
      const pct = Math.round(avgRate * 100);
      opts.push({
        kind: 'extendDeadline',
        title: '延长截止日期',
        rationale: `最近两期完成率仅 ${pct}%，自评负载偏重（${avgLoad.toFixed(2)}）`,
        impact: '总时长相应延长',
        consequences: '压力下降，但目标达成时间后移',
      });
      opts.push({
        kind: 'narrowScope',
        title: '缩小目标范围，保住核心',
        rationale: '当前目标下的任务量超出实际可投入时间',
        impact: '总时长不变或缩短，但放弃部分内容',
        consequences: '更容易完成、正反馈更强；放弃的部分需在成功标准里同步删掉，避免「名义上还在」',
      });
      opts.push({
        kind: 'lowerWeekly',
        title: '下调每周目标时长',
        rationale: '现有周预算与实际执行能力不匹配',
        impact: '每周投入下降，总时长延长',
        consequences: '可持续性提高，但需要重新确认截止日期是否还成立',
      });
    }
  }

  const risky = drift.filter((d): d is Extract<Drift, { kind: 'milestoneRisk' }> => d.kind === 'milestoneRisk');
  for (const r of risky.slice(0, 2)) {
    const m = plan.milestones.find((x) => x.id === r.milestoneId);
    if (!m) continue;
    opts.push({
      kind: 'splitMilestone',
      title: `拆分里程碑「${m.title}」`,
      rationale: `剩余任务还需 ${Math.round(r.shortfallMin / 60)} 小时，超出到 ${m.due} 为止的可用时长`,
      impact: '总时长不变，但把一个大目标切成两个可达成的小目标',
      consequences: '能更早拿到阶段性正反馈；代价是里程碑结构变复杂',
    });
  }

  return opts;
}

/* ------------------------------------------------------------------ *
 * 聚合：复盘页需要的一整屏数据
 * ------------------------------------------------------------------ */

export type ReviewReport = {
  today: string;
  drift: Drift[];
  adjustments: AppliedAdjustment[];
  goalOptions: GoalOption[];
  masteryUpdates: MasteryUpdate[];
};

export function reviewPlan(plan: PlanFile, today: string): ReviewReport {
  const drift = detectDrift(plan, today);
  return {
    today,
    drift,
    adjustments: proposeReschedule(plan, today),
    goalOptions: proposeGoalOptions(plan, drift),
    masteryUpdates: proposeMasteryUpdates(plan),
  };
}
