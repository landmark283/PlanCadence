/**
 * advisor：把引擎算出的确定性结果，交给 LLM 变成学生读得进去的话。
 *
 * ## 职责边界（这是本文件最重要的一条设计）
 *
 * **引擎算，LLM 说。** 日期、时长、依赖顺序、护栏全部由 `engine.ts` 决定，
 * LLM 的输出是**表现层**，不是决策层。具体地：
 *
 *   · LLM 可以改写每条调整的理由、写一段综述、补充语义层面的提醒
 *   · LLM **不能**新增/删除任务、不能指定引擎没算出的日期
 *   · LLM 提到的每个 taskId、每个协商选项，都必须能在引擎输出里找到，
 *     否则一律丢弃并计数
 *
 * 这样一来，模型幻觉再离谱也不会把一份错误的计划写进学生的文件——
 * 最坏情况只是措辞降级回引擎原文（`engineView`），这正是我们的降级路径。
 */
import { z } from 'zod';
import type { PlanFile } from '../plan/schema.ts';
import type { GoalOption, ReviewReport } from '../plan/engine.ts';
import { adjustmentTaskId, describeAdjustment, describeDrift, describeOption } from '../plan/describe.ts';

/* ------------------------------------------------------------------ *
 * 契约定
 * ------------------------------------------------------------------ */

export const AdvisorOutput = z.object({
  /** 给学生看的综述，2–4 句 */
  narrative: z.string().min(1).max(1200),
  /** 改写后的逐条理由。taskId 必须在引擎的建议里存在。 */
  reasons: z
    .array(
      z.object({
        taskId: z.string().min(1).max(32),
        reason: z.string().min(1).max(300),
      })
    )
    .max(30),
  /** 规则算不出、但值得提醒的事（例如学生笔记里透露的困难） */
  cautions: z.array(z.string().min(1).max(300)).max(5),
  /** 推荐的协商选项 kind，必须来自引擎已给出的选项 */
  recommendedOptions: z.array(z.string().min(1).max(40)).max(4),
});
export type AdvisorOutput = z.infer<typeof AdvisorOutput>;

/* ------------------------------------------------------------------ *
 * 校验后的视图（真正给界面用的东西）
 * ------------------------------------------------------------------ */

export type AdvisorAdjustmentView = {
  taskId: string;
  title: string;
  /** 调整前的排期。null = 原本在待排池 */
  from: string | null;
  /** 调整后的排期。null = 移回待排池 */
  to: string | null;
  /** 引擎给的理由，永远存在，作为兜底 */
  engineReason: string;
  /** LLM 改写后的理由；缺失或不合格时为 null，界面应回退到 engineReason */
  llmReason: string | null;
};

export type AdvisorView = {
  narrative: string;
  /** narrative 是模型写的还是引擎拼的 */
  narrativeSource: 'llm' | 'engine';
  adjustments: AdvisorAdjustmentView[];
  cautions: string[];
  recommendedOptions: GoalOption[];
  /** 被丢弃的模型引用数量——用来观察模型的幻觉率，不是错误 */
  dropped: { reasons: number; options: number };
};

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

const SYSTEM = `你是一个学习规划助手，用简体中文工作。你的服务对象是中国的大学生。
你的任务是把系统已经算好的调整，讲清楚给学生听。

严格遵守：
1. 只能使用「系统算出的调整」里出现的 taskId 和日期。不得编造任务、日期或时长。
2. reasons 只能为「系统算出的调整」里列出的任务写理由，不能多写。
3. recommendedOptions 只能从「可用的协商选项」里选 kind，不能自创。
4. 语气像一个了解情况、说话直接的学长：具体、不空洞、不奉承、不打鸡血。
5. 不要重复系统已经算出的数字之外的内容；不要解释你的推理过程。
6. narrative 与 cautions 里不要出现 taskId 这类内部标识（如 t_dp02、t_graph01）——学生不认识它们，直接用任务名。
   只有结构化字段（reasons）里的 taskId 是给程序用的，照填即可。
7. 全部用简体中文。

只输出 JSON，不要 markdown 围栏，不要任何解释文字。格式：
{
  "narrative": "2-4 句综述",
  "reasons": [{ "taskId": "t_xxx", "reason": "一句话，说清为什么这么调整" }],
  "cautions": ["值得提醒但规则算不出来的事"],
  "recommendedOptions": ["deepen"]
}`;

function taskTitle(plan: PlanFile, id: string): string {
  return plan.tasks.find((t) => t.id === id)?.title ?? id;
}

/**
 * 调整前该任务的排期。界面要显示「原日期 → 新日期」，
 * 而原日期不能从理由文本里解析——那是展示文案，不是数据。
 */
function taskScheduledFor(plan: PlanFile, id: string): string | null {
  return plan.tasks.find((t) => t.id === id)?.scheduledFor ?? null;
}

/**
 * 只把与本次调整/偏差相关的任务的上下文带上，避免被无关内容撑爆。
 *
 * 除了笔记，还要带上 pinned / notBefore——否则模型会给出错误的提醒。
 * 曾经就发生过：模型看到「等期中考试周之后再安排」的笔记，
 * 却不知道 `notBefore` 已经把它安排到了期中之后，于是提了个不存在的问题。
 */
function relevantTaskContext(plan: PlanFile, report: ReviewReport): string[] {
  const ids = new Set<string>();
  for (const a of report.adjustments) {
    const id = adjustmentTaskId(a);
    if (id) ids.add(id);
  }
  for (const d of report.drift) {
    if ('taskId' in d) ids.add(d.taskId);
    if (d.kind === 'chainBlocked') ids.add(d.blockedBy);
  }

  const lines: string[] = [];
  for (const t of plan.tasks) {
    if (!ids.has(t.id)) continue;
    const bits: string[] = [];
    if (t.pinned) bits.push('学生已手动锁定此日期');
    if (t.notBefore) bits.push(`学生要求不得早于 ${t.notBefore}`);
    if (t.notes.trim()) bits.push(`笔记：${t.notes.trim()}`);
    if (bits.length) lines.push(`- ${t.id}「${t.title}」${bits.join('；')}`);
  }
  return lines;
}

export function buildAdvisorMessages(plan: PlanFile, report: ReviewReport): { system: string; user: string } {
  const titleOf = (id: string) => taskTitle(plan, id);

  const driftText = report.drift.length
    ? report.drift.map((d) => `- ${describeDrift(d, titleOf)}`).join('\n')
    : '（无偏差）';

  const adjText = report.adjustments.length
    ? report.adjustments
        .map((a) => {
          const id = adjustmentTaskId(a);
          return `- taskId=${id ?? '(无)'}  ${describeAdjustment(a, titleOf)}`;
        })
        .join('\n')
    : '（无调整建议）';

  const optText = report.goalOptions.length
    ? report.goalOptions.map((o) => `- kind=${o.kind}  ${o.title}｜依据：${o.rationale}`).join('\n')
    : '（无可选协商选项）';

  const notes = relevantTaskContext(plan, report);
  const recentReviews = plan.reviews
    .slice(-2)
    .map((r) => `- ${r.at.slice(0, 10)}：计划 ${r.plannedTasks} 项 / 完成 ${r.completedTasks} 项${r.loadFeedback != null ? `，自评负载 ${r.loadFeedback}` : ''}${r.notes ? `，备注：${r.notes.trim()}` : ''}`)
    .join('\n');

  // blackout 必须带出来。否则模型无法判断某个日期是否落在考试周前后，
  // 只能给出「这个和考试周的关系还没核对过」这类没有价值的模糊提醒。
  const blackouts = plan.constraints.blackouts.length
    ? plan.constraints.blackouts.map((b) => `${b.from} ~ ${b.to}${b.reason ? `（${b.reason}）` : ''}`).join('；')
    : '（无）';

  const user = `## 学生目标
${plan.goal.statement}${plan.goal.deadline ? `（截止 ${plan.goal.deadline}）` : ''}

## 时间约束
每周可投入 ${plan.constraints.weeklyMinutes} 分钟，单次上限 ${plan.constraints.maxSessionMinutes} 分钟，已配置 ${plan.constraints.availableSlots.length} 个可用时段
不可用区间：${blackouts}

## 最近复盘
${recentReviews || '（无）'}

## 基准日
${report.today}

## 偏差
${driftText}

## 系统算出的调整
${adjText}

## 可用的协商选项
${optText}
${notes.length ? `\n## 相关任务的补充信息（可用于 cautions）\n${notes.join('\n')}\n` : ''}
请按系统提示的 JSON 格式输出。`;

  return { system: SYSTEM, user };
}

/* ------------------------------------------------------------------ *
 * 校验：把模型输出裁到引擎的范围内
 * ------------------------------------------------------------------ */

/**
 * 逐条核对模型的引用。**任何对不上引擎的引用都被丢弃**，而不是报错——
 * 模型偶尔多写一条不该让整个复盘失败，降级到引擎原文即可。
 */
export function validateAdvisorOutput(output: AdvisorOutput, plan: PlanFile, report: ReviewReport): AdvisorView {
  const validIds = new Set(
    report.adjustments.map(adjustmentTaskId).filter((id): id is string => id !== null)
  );

  const llmReason = new Map<string, string>();
  let droppedReasons = 0;
  for (const r of output.reasons) {
    if (!validIds.has(r.taskId)) {
      droppedReasons++;
      continue;
    }
    if (!llmReason.has(r.taskId)) llmReason.set(r.taskId, r.reason); // 同一任务多条时取第一条
  }

  const optionByKind = new Map(report.goalOptions.map((o) => [o.kind as string, o]));
  const recommended: GoalOption[] = [];
  let droppedOptions = 0;
  for (const kind of output.recommendedOptions) {
    const o = optionByKind.get(kind);
    if (!o) {
      droppedOptions++;
      continue;
    }
    if (!recommended.includes(o)) recommended.push(o);
  }

  const adjustments: AdvisorAdjustmentView[] = [];
  for (const a of report.adjustments) {
    const id = adjustmentTaskId(a);
    if (!id) continue;
    adjustments.push({
      taskId: id,
      title: taskTitle(plan, id),
      from: taskScheduledFor(plan, id),
      to: a.kind === 'reschedule' ? a.scheduledFor : taskScheduledFor(plan, id),
      engineReason: a.reason,
      llmReason: llmReason.get(id) ?? null,
    });
  }

  return {
    narrative: output.narrative,
    narrativeSource: 'llm',
    adjustments,
    cautions: output.cautions,
    recommendedOptions: recommended,
    dropped: { reasons: droppedReasons, options: droppedOptions },
  };
}

/* ------------------------------------------------------------------ *
 * 降级路径（同时就是 mock provider 的输出基准）
 * ------------------------------------------------------------------ */

/**
 * 完全不用 LLM，仅用引擎结果拼出同样的视图。
 *
 * 这条路有两个用途，都很重要：
 *   1. 降级：模型不可用/校验失败/没配 Key 时，功能不能整个消失
 *   2. 比赛现场兜底：网络或额度出问题时一键切换
 */
export function engineView(plan: PlanFile, report: ReviewReport): AdvisorView {
  const titleOf = (id: string) => taskTitle(plan, id);

  const adjustments: AdvisorAdjustmentView[] = [];
  for (const a of report.adjustments) {
    const id = adjustmentTaskId(a);
    if (!id) continue;
    adjustments.push({
      taskId: id,
      title: titleOf(id),
      from: taskScheduledFor(plan, id),
      to: a.kind === 'reschedule' ? a.scheduledFor : taskScheduledFor(plan, id),
      engineReason: a.reason,
      llmReason: null,
    });
  }

  const parts: string[] = [];
  if (report.drift.length) {
    const overdue = report.drift.filter((d) => d.kind === 'overdue').length;
    const overrun = report.drift.filter((d) => d.kind === 'overrun').length;
    const risk = report.drift.filter((d) => d.kind === 'milestoneRisk').length;
    const bits: string[] = [];
    if (overdue) bits.push(`${overdue} 个任务已过期`);
    if (overrun) bits.push(`${overrun} 个任务实际耗时超出预估`);
    if (risk) bits.push(`${risk} 个里程碑有风险`);
    parts.push(`本期发现 ${bits.join('，')}。`);
  } else {
    parts.push('本期没有发现偏差。');
  }
  parts.push(
    adjustments.length
      ? `系统给出 ${adjustments.length} 条调整建议，请逐条确认。`
      : '当前排期无需调整。'
  );

  return {
    narrative: parts.join(''),
    narrativeSource: 'engine',
    adjustments,
    cautions: [],
    recommendedOptions: report.goalOptions,
    dropped: { reasons: 0, options: 0 },
  };
}

/** 模型输出里所有引用都无效时的兜底判断：这类输出不值得展示给用户 */
export function isUseful(output: AdvisorOutput, report: ReviewReport): boolean {
  if (!report.adjustments.length) return true; // 没调整时综述本身仍有价值
  const validIds = new Set(report.adjustments.map(adjustmentTaskId).filter(Boolean));
  return output.reasons.some((r) => validIds.has(r.taskId));
}
