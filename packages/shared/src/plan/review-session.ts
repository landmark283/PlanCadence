/**
 * 复盘会话：问什么、给哪些候选卡、方向那句话怎么写。
 *
 * ## 全部是本机规则，不是模型
 *
 * 「这周该问什么」和「该给哪些卡」是由**事实**决定的，不是由灵感决定的。
 * 所以它们是纯函数（可单测），模型在这一屏只做两件事：
 *   1. 把方向那句话说得更顺（本机有一句保底）；
 *   2. 把卡片上的理由改写成更好懂的措辞（引擎原文永远保留并列显示）。
 *
 * 好处：**复盘在断网时完整可用**——事实、问题、卡片、应用都不经过网络。
 *
 * ## 「尽量预测学生需要什么卡片」怎么落
 *
 * 不是「一条 drift 对应一条卡」，而是「一类需要对应一组候选」：
 *
 * | 事实 | 学生可能的需要 | 给的候选 |
 * |---|---|---|
 * | 落后了 | 往后挪 / 不做了 | 改期、放弃 |
 * | 耗时超预估 | 调高预估 / 拆开 | 调时长 |
 * | 学得比预期快 | 加点量 | 加一张「加练」 |
 * | 卡了很久 | 降投入 / 不做了 | 调低时长、放弃 |
 * | 目标要到期而进度不够 | 把截止日往后挪 / 降低周投入 | 改目标、改档案 |
 * | 排得超过预算 | 往后挪 | 改期（引擎已给） |
 *
 * **范围画在哪**：只给「代码能算出一个具体数」的候选。
 * 需要凭空编内容的一律不做——比如「拆成两次」得编出后半部分叫什么，
 * 那就是在编内容，而卡片标题是学生一眼能看出真假的东西。
 * 唯一用模板生成标题的是「加练：<原标题>」：它明确是模板，
 * 而且学生改几个字就能用——这正是「帮你大体把卡片写好」的意思。
 */
import { addDays } from './engine.ts';
import { fmtMonthDay } from './calendar.ts';
import { ESTIMATE_STEP } from './task-patch.ts';
import { validateProposal } from './proposal.ts';
import type { ReviewReport, Drift } from './engine.ts';
import type { PlanFile, Task } from './schema.ts';
import type { Answer, QuestionSpec } from '../llm/interview.ts';
import type { Proposal } from './proposal.ts';

/** 问题的 id。稳定，因为界面要拿它存答案 */
export const Q_REASON = 'q_reason';
export const Q_OVERRUN = 'q_overrun';
export const Q_GOAL = 'q_goal';

/** 学生可以怎么回答「没做完主要是因为」。取值要在代码里用，所以是常量 */
export const REASON_TIME = 'time';
export const REASON_HARD = 'hard';
export const REASON_BUSY = 'busy';
export const REASON_UNWILLING = 'unwilling';

/** 一次复盘最多问几个问题。两个以上就开始像填表了 */
export const MAX_REVIEW_QUESTIONS = 2;

/** 过期多久之后才主动提议「不做了」。太短会显得系统急着放弃 */
const GIVE_UP_DAYS = 14;

function driftOf(report: ReviewReport, kind: Drift['kind']) {
  return report.drift.filter((d) => d.kind === kind);
}

/** 取单选题的答案值。不是单选（或没答）就给 null */
function singleValue(a: Answer | undefined): string | null {
  return a && a.kind === 'single' ? a.value : null;
}

/** 15 分钟的整数倍，向上取整。改时长只改到「档位的下一个刻度」，不制造 78 分钟这种数 */
function roundUpToStep(min: number): number {
  return Math.max(ESTIMATE_STEP, Math.ceil(min / ESTIMATE_STEP) * ESTIMATE_STEP);
}

/* ------------------------------------------------------------------ *
 * 问什么
 * ------------------------------------------------------------------ */

/**
 * 条件出题：**只在答案会改变建议的时候问**。
 *
 * 这一条比题目本身重要得多。一个每周都问三个问题的系统，学生会直接点跳过，
 * 于是那三个答案全是噪音；而一个「只在有落后时才问一句」的系统，
 * 学生知道它问是因为真的有事。所以这里没有任何「例行问题」。
 */
export function reviewQuestions(plan: PlanFile, report: ReviewReport): QuestionSpec[] {
  const out: QuestionSpec[] = [];
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));

  const backlogDrift = [...driftOf(report, 'overdue'), ...driftOf(report, 'stalled')];
  if (backlogDrift.length > 0) {
    const names = backlogDrift
      .slice(0, 3)
      .map((d) => byId.get('taskId' in d ? d.taskId : '')?.title ?? '')
      .filter(Boolean);
    out.push({
      id: Q_REASON,
      field: null,
      kind: 'single',
      prompt: `这周没做完的 ${backlogDrift.length} 项，主要是因为？`,
      // why 是契约里必填的：每一题都要说清它对应哪个决定
      why: '这决定我是该把它们往后挪、把难度降下来，还是先放回池子里。',
      options: [
        { value: REASON_TIME, label: '时间不够' },
        { value: REASON_HARD, label: '比预期难' },
        { value: REASON_BUSY, label: '有别的急事' },
        { value: REASON_UNWILLING, label: '就是不想做' },
      ],
      min: null,
      max: null,
      step: null,
      unit: null,
      placeholder: null,
      suggestions: names,
    });
  }

  if (driftOf(report, 'overrun').length > 0) {
    out.push({
      id: Q_OVERRUN,
      field: null,
      kind: 'single',
      prompt: '有几项的实际耗时远超预估。是估错了，还是这次特别费劲？',
      why: '前者我直接把预估调上去；后者说明这一步本身就重，该拆开做。',
      options: [
        { value: 'underestimated', label: '我一开始就估少了' },
        { value: 'unusually_hard', label: '这次特别费劲' },
      ],
      min: null,
      max: null,
      step: null,
      unit: null,
      placeholder: null,
      suggestions: [],
    });
  }

  /**
   * 目标那一题只在**真的需要谈**的时候出现。
   *
   * 里程碑有风险、或者截止日已经在两周之内而进度不够——这两种情况下
   * 「要不要改目标」是一个真问题；其余时候问它只是提醒学生「你可能要失败」。
   */
  const goalSoon =
    plan.goal.deadline !== null && plan.goal.deadline <= addDays(report.today, 14);
  const riskyNow = driftOf(report, 'milestoneRisk')
    .map((d) => (d.kind === 'milestoneRisk' ? plan.milestones.find((m) => m.id === d.milestoneId) : undefined))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (riskyNow.length > 0 || goalSoon) {
    /**
     * 问句里必须带上**是哪条线**。
     *
     * 多目标时「时间可能不够」是一句无法回答的话：学生有三条线，
     * 他不知道系统说的是哪一条，也就没法在「挪截止日 / 少排一点 / 我自己想办法」
     * 之间选。带上名字之后，这三个选项才各自对应一个具体决定。
     */
    const which = riskyNow.length
      ? `${riskyNow.map((m) => `「${m.title}」`).join('、')}${riskyNow.length > 1 ? '这些线' : ''}按现在的进度可能赶不上`
      : '按现在的进度，时间可能不够';
    out.push({
      id: Q_GOAL,
      field: null,
      kind: 'single',
      prompt: `${which}。你想怎么处理？`,
      why: '是往后挪那条线的截止日，还是把每周投入降下来先把稳的做完。',
      options: [
        { value: 'extend', label: '截止日往后挪一点' },
        { value: 'lower', label: '每周少排一点' },
        { value: 'keep', label: '不改，我自己想办法' },
      ],
      min: null,
      max: null,
      step: null,
      unit: null,
      placeholder: null,
      suggestions: [],
    });
  }

  return out.slice(0, MAX_REVIEW_QUESTIONS);
}

/* ------------------------------------------------------------------ *
 * 给哪些卡
 * ------------------------------------------------------------------ */

/**
 * 候选卡片。
 *
 * 起点是引擎已经算好的调整（`report.adjustments`，`kind: 'reschedule'`），
 * 然后按需要**补上**别的种类。全部默认勾上——和结账页「默认都没做」同一种思路：
 * 让最常见的情况零额外操作。学生不要的那条点一下划掉。
 */
export function reviewProposals(
  plan: PlanFile,
  report: ReviewReport,
  answers: Record<string, Answer> = {},
): Proposal[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const titleOf = (id: string) => byId.get(id)?.title ?? '（已删除的一项）';
  // 复盘的三个问题都是单选题，所以答案都是 `single`；别的形状一律当没答
  const reasonAnswer = singleValue(answers[Q_REASON]);
  const overrunAnswer = singleValue(answers[Q_OVERRUN]);
  const goalAnswer = singleValue(answers[Q_GOAL]);

  const out: Proposal[] = [];
  const seen = new Set<string>();

  const push = (p: Proposal) => {
    const key = p.kind === 'addTask' ? `addTask:${p.task.title}` : `${p.kind}:${'taskId' in p ? p.taskId : ''}`;
    if (seen.has(key)) return;
    /**
     * **每一张卡都必须过得了自己的校验。**
     *
     * 不能省这一步：卡片是拿来点的，一张「点了会失败」的卡比不给卡更糟。
     * 而且它抓过一个真 bug——复盘会话拿到的「今天」如果是**过期的**
     * （启动时时钟还没接上，用的是设备日期），引擎会按那个日期算出
     * 一个相对真实今天已经过去的排期，而卡片上就写着「→ 10/14」。
     *
     * 过不了就丢掉，不再往下传。这是**防御**，不是根因修复：
     * 根因是会话必须在时钟接上之后再开（见 `(tabs)/review.tsx` 的 `storageReady` 判断）。
     */
    const check = validateProposal(p, plan, report.today);
    if (!check.ok) return;
    seen.add(key);
    out.push(p);
  };

  /* ── 1. 引擎已经算好的改期 ───────────────────────────────
   * 学生答「就是不想做」时**不给**改期卡：他不想做，挪到哪天都一样。
   * 这时候给的是「放回池子」——见下面第 5 段。 */
  if (reasonAnswer !== REASON_UNWILLING) {
    for (const a of report.adjustments) {
      if (a.kind !== 'reschedule') continue;
      push({
        kind: 'reschedule',
        taskId: a.taskId,
        scheduledFor: a.scheduledFor,
        reason: a.reason,
        engineReason: a.reason,
      });
    }
  }

  /* ── 2. 耗时超预估 → 把预估调上去 ───────────────────────
   * 学生答「时间不够」时不给：时间不够还往上调时长，只会更排不下。 */
  if (reasonAnswer !== REASON_TIME) {
    for (const d of driftOf(report, 'overrun')) {
      if (d.kind !== 'overrun') continue;
      const t = byId.get(d.taskId);
      if (!t) continue;
      const target = roundUpToStep(Math.ceil(t.estimateMin * d.ratio));
      if (target <= t.estimateMin) continue;
      const why = `实际耗时是预估的 ${d.ratio} 倍`;
      push({
        kind: 'estimate',
        taskId: t.id,
        estimateMin: target,
        reason: why,
        engineReason: why,
      });
    }
  }

  /* ── 3. 卡了很久 → 把单次投入降下来 ─────────────────────
   * `stalled` 是「进行中很久没动静」，多半是这一步一次做不完。
   * 学生答「比预期难」时这一条**尤其**该给，所以它不受 reason 过滤。 */
  for (const d of driftOf(report, 'stalled')) {
    if (d.kind !== 'stalled') continue;
    const t = byId.get(d.taskId);
    if (!t) continue;
    const target = Math.max(ESTIMATE_STEP, roundUpToStep(t.estimateMin * 0.6));
    if (target >= t.estimateMin) continue;
    const why = `已经 ${d.days} 天没动静，一次做 ${t.estimateMin} 分钟可能太长`;
    push({
      kind: 'estimate',
      taskId: t.id,
      estimateMin: target,
      reason: why,
      engineReason: why,
    });
  }

  /* ── 4. 学得比预期快 → 加一张「加练」 ───────────────────
   * 标题用模板而不是编一个任务名：编名字就是编内容，而卡片标题是学生一眼看得懂的东西。
   * 模板 + 可编辑 = 改几个字就能用。 */
  for (const d of driftOf(report, 'underrun')) {
    if (d.kind !== 'underrun') continue;
    const t = byId.get(d.taskId);
    if (!t) continue;
    const why = `「${t.title}」只用了预估的 ${d.ratio}`;
    push({
      kind: 'addTask',
      task: {
        title: `加练：${t.title}`,
        type: t.type === 'read' ? 'practice' : t.type,
        estimateMin: roundUpToStep(t.estimateMin),
        notes: '',
        scheduledFor: null,
        notBefore: null,
        tags: [],
      },
      reason: `${why}，可以再加一轮同类练习`,
      engineReason: why,
    });
  }

  /* ── 5. 学生说「就是不想做」→ 放回池子 ───────────────────
   * 这不是「挪到别的一天」——学生表达的是意愿问题，那就该退出日程表，
   * 而不是换个日子继续追着他。 */
  if (reasonAnswer === REASON_UNWILLING) {
    for (const d of [...driftOf(report, 'overdue'), ...driftOf(report, 'stalled')]) {
      const id = 'taskId' in d ? d.taskId : null;
      if (!id) continue;
      const why = '你说不想做';
      push({
        kind: 'reschedule',
        taskId: id,
        scheduledFor: null,
        reason: `${why}，先放回待排池`,
        engineReason: why,
      });
    }
  }

  /* ── 6. 拖得太久 → 主动提议「不做了」 ───────────────────
   * 只在过期超过两周时给。太短会显得系统急着放弃，
   * 而学生一旦觉得「它老想让我删东西」，这条卡就再也不会被认真看。 */
  for (const d of driftOf(report, 'overdue')) {
    if (d.kind !== 'overdue' || d.days < GIVE_UP_DAYS) continue;
    const t = byId.get(d.taskId);
    if (!t) continue;
    const why = `已经过期 ${d.days} 天`;
    push({
      kind: 'dropTask',
      taskId: t.id,
      reason: `${why}，可以干脆不做了`,
      engineReason: why,
    });
  }

  /* ── 7. 目标：只在代码能算出具体数的时候给 ─────────────── *
   * 这里修过一个真错：原来的卡在检测到 `milestoneRisk` 时改的是
   * **总目标的截止日**（`goal.deadline + 14`）。总目标在明年四月、
   * 而紧的是十一月底那个赛事时，那张卡什么都没解决，却写着「里程碑可能赶不上」——
   * 比不给卡更坏。现在**紧的是哪条线就改哪条线的截止日**。
   *
   * 总目标那张卡只在学生明确说要挪总截止日、而**没有任何带截止日的目标**可挪时给。
   */
  const riskyMs = driftOf(report, 'milestoneRisk').filter(
    (d): d is Extract<Drift, { kind: 'milestoneRisk' }> => d.kind === 'milestoneRisk'
  );
  const msById = new Map(plan.milestones.map((m) => [m.id, m]));

  /** 攥着那条线的名字，卡片上才分得清是哪一个目标 */
  const riskyDated = riskyMs
    .map((d) => ({ d, m: msById.get(d.milestoneId) }))
    .filter((x): x is { d: Extract<Drift, { kind: 'milestoneRisk' }>; m: NonNullable<typeof x.m> } =>
      Boolean(x.m?.due)
    );

  if (goalAnswer === 'extend') {
    for (const { d, m } of riskyDated) {
      const to = addDays(m.due!, 14);
      const why = `「${m.title}」还差 ${Math.round(d.shortfallMin / 60)} 小时，可用只有 ${Math.round(d.capacityMin / 60)} 小时`;
      push({
        kind: 'milestone',
        milestoneId: m.id,
        patch: { due: to },
        reason: `${why}，把它的截止日往后挪两周到 ${to}`,
        engineReason: why,
      });
    }
    // 一个带截止日的目标都没有时，唯一能挪的就是总目标
    if (!riskyDated.length && plan.goal.deadline) {
      const to = addDays(plan.goal.deadline, 14);
      const why = `按现在的进度，原截止日 ${plan.goal.deadline} 偏紧`;
      push({ kind: 'goal', patch: { deadline: to }, reason: `${why}，往后挪两周到 ${to}`, engineReason: why });
    }
  } else if (goalAnswer === 'keep') {
    // 学生明确说「不改，我自己想办法」——那就不给任何目标卡
  } else if (goalAnswer === 'lower') {
    const hours = plan.constraints.weeklyMinutes / 60;
    const target = Math.max(1, Math.round(hours * 0.7));
    const why = `现在每周排 ${plan.constraints.weeklyMinutes} 分钟，你可能消化不了`;
    push({
      kind: 'profile',
      patch: { weeklyHours: target },
      reason: `${why}，先按每周 ${target} 小时算`,
      engineReason: why,
    });
  } else {
    /**
     * 没问到（或没答）但某条线确实来不及：给一张供学生决定。
     *
     * 卡上必须带**那条线的名字和它自己的截止日**：多目标时只说
     * 「某个目标可能赶不上」，学生不知道指的是哪一条，也就没法判断该不该同意。
     */
    for (const { d, m } of riskyDated) {
      const to = addDays(m.due!, 14);
      const why = `按现在的进度，「${m.title}」（${m.due} 截止）可能赶不上`;
      push({
        kind: 'milestone',
        milestoneId: m.id,
        patch: { due: to },
        reason: `${why}，可以把它的截止日往后挪两周到 ${to}`,
        engineReason: why,
      });
    }
  }

  void titleOf;
  void overrunAnswer;
  return out;
}

/**
 * ① 那一块：**这周发生了什么**。
 *
 * 全部由引擎的事实推出来，**不经过模型**——所以断网时内容一字不差，
 * 只是措辞糙一点。这一条很重要：它是整场复盘的依据，
 * 如果连「发生了什么」都要等模型，那断网时这一屏就什么都不用看了。
 */
export type ReviewFacts = {
  text: string;
  chips: { key: string; text: string; tone: 'warning' | 'success' | 'neutral' }[];
};

export function reviewFacts(plan: PlanFile, report: ReviewReport): ReviewFacts {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const of = (kind: Drift['kind']) => report.drift.filter((d) => d.kind === kind);
  const count = (kind: Drift['kind']) => of(kind).length;

  const chips: ReviewFacts['chips'] = [];
  if (count('overdue')) chips.push({ key: 'overdue', text: `${count('overdue')} 项落后`, tone: 'warning' });
  if (count('overrun')) chips.push({ key: 'overrun', text: `${count('overrun')} 项超预估`, tone: 'warning' });
  if (count('underrun')) chips.push({ key: 'underrun', text: `${count('underrun')} 项比预期快`, tone: 'success' });
  if (count('stalled')) chips.push({ key: 'stalled', text: `${count('stalled')} 项停滞`, tone: 'warning' });
  if (count('chainBlocked')) chips.push({ key: 'chainBlocked', text: `${count('chainBlocked')} 项被前置挡住`, tone: 'warning' });
  if (count('milestoneRisk')) chips.push({ key: 'milestoneRisk', text: `${count('milestoneRisk')} 个目标有风险`, tone: 'warning' });
  if (count('budgetOver')) chips.push({ key: 'budgetOver', text: `${count('budgetOver')} 周超载`, tone: 'warning' });

  if (!chips.length) {
    return { text: '这周没有发现偏差——排期和你实际做的情况基本对得上。', chips };
  }

  /**
   * 句子只挑**最有信息量的两件事**说。
   *
   * 把七类偏差都念一遍就等于什么都没说（学生一眼扫过去只会看到一片红）。
   * 挑「落后了多少天」和「超了几倍」，是因为这两个最直接地对应
   * 上面那几类要不要改。
   */
  const parts: string[] = [];
  const worstOverdue = of('overdue').sort((a, b) => (b.kind === 'overdue' ? b.days : 0) - (a.kind === 'overdue' ? a.days : 0))[0];
  const worstOverrun = of('overrun')[0];
  const stalledOne = of('stalled')[0];

  if (worstOverdue?.kind === 'overdue') {
    const t = byId.get(worstOverdue.taskId);
    parts.push(
      t
        ? `「${t.title}」已经过期 ${worstOverdue.days} 天`
        : `${count('overdue')} 项已经过期`
    );
  }
  if (worstOverrun?.kind === 'overrun') {
    const t = byId.get(worstOverrun.taskId);
    parts.push(t ? `「${t.title}」实际花了预估的 ${worstOverrun.ratio} 倍` : `有 ${count('overrun')} 项严重超时`);
  }
  if (stalledOne?.kind === 'stalled' && parts.length < 2) {
    const t = byId.get(stalledOne.taskId);
    parts.push(t ? `「${t.title}」进行中已经 ${stalledOne.days} 天没动静` : `有 ${count('stalled')} 项停滞`);
  }
  /**
   * 目标有风险时**必须点名**。
   *
   * 多目标之后「2 个目标有风险」这句话是不完整的：学生手里可能有三条线，
   * 他要知道紧的是哪一条、差多少，才能决定是挪那条线的截止日还是加时长。
   * 放在最后补一句（而不是和上面两条抢位置）：前面那两条说的是「这周发生了
   * 什么」，这一条说的是「照着这么走下去会怎样」。
   */
  const risky = of('milestoneRisk')
    .map((d) => (d.kind === 'milestoneRisk' ? plan.milestones.find((m) => m.id === d.milestoneId) : undefined))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  if (risky.length) {
    const names = risky.slice(0, 2).map((m) => `「${m.title}」${m.due ? `（${fmtMonthDay(m.due)} 截止）` : ''}`);
    parts.push(`按现在的进度，${names.join('、')}${risky.length > 2 ? ` 等 ${risky.length} 条线` : ''}可能赶不上`);
  }

  return { text: `${parts.join('；')}。`, chips };
}

/**
 * 方向那句话的**本机保底版本**。
 *
 * 模型会把这句话说得更顺，但这一句在任何情况下都要有——
 * 复盘是「断网也完整可用」的那一屏。
 */
export function reviewDirection(plan: PlanFile, report: ReviewReport, proposals: Proposal[]): string {
  const overdue = driftOf(report, 'overdue').length;
  const overrun = driftOf(report, 'overrun').length;
  const stalled = driftOf(report, 'stalled').length;
  const underrun = driftOf(report, 'underrun').length;
  const riskyMs = driftOf(report, 'milestoneRisk')
    .map((d) => (d.kind === 'milestoneRisk' ? plan.milestones.find((m) => m.id === d.milestoneId) : undefined))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));

  const facts: string[] = [];
  if (overdue) facts.push(`${overdue} 项落后`);
  if (overrun) facts.push(`${overrun} 项耗时超预估`);
  if (stalled) facts.push(`${stalled} 项卡住`);
  if (underrun) facts.push(`${underrun} 项比预期快`);
  // 多目标时「哪条线紧」是这一屏最有价值的一句，所以它也进事实列表
  if (riskyMs.length) facts.push(`${riskyMs.map((m) => `「${m.title}」`).join('、')}来不及`);

  if (proposals.length === 0) {
    return facts.length
      ? `${facts.join('、')}。但这周没有必须改的东西，按现在的节奏继续就行。`
      : '这周没有发现需要调整的地方，按现在的节奏继续就行。';
  }

  const moves = proposals.filter((p) => p.kind === 'reschedule').length;
  const times = proposals.filter((p) => p.kind === 'estimate').length;
  const adds = proposals.filter((p) => p.kind === 'addTask').length;
  const retarget = proposals.filter((p) => p.kind === 'milestone').length;
  const newGoals = proposals.filter((p) => p.kind === 'addMilestone').length;

  const plan_ = ['下周'];
  if (moves) plan_.push(`${moves} 项换个日子`);
  if (times) plan_.push(`${times} 项的时长调整一下`);
  if (adds) plan_.push(`补 ${adds} 项练习`);
  if (retarget) plan_.push(`${retarget} 个目标的截止日往后挪`);
  if (newGoals) plan_.push(`新增 ${newGoals} 个目标`);
  if (plan_.length === 1) plan_.push(`按下面 ${proposals.length} 处微调`);

  return `${facts.length ? `${facts.join('、')}。` : ''}${plan_.join('，')}。`;
}
