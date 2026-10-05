/**
 * 把引擎产出的结构化结果渲染成中文措辞。
 *
 * 抽到共享层的理由：CLI、服务端、移动端必须用**完全一致**的说法。
 * 同一件事（比如「这条为什么被顺延」）在三处措辞不同，是最容易被评委
 * 一眼看穿「拼装感」的细节。
 */
import type { AppliedAdjustment } from './commands.ts';
import type { Drift, GoalOption } from './engine.ts';
import type { PlanFile } from './schema.ts';
import { fmtDayWithWeekday, fmtMinutes, fmtMonthDay } from './calendar.ts';
import { proposalKey } from './proposal.ts';
import type { GoalPatch, ProfilePatch, Proposal } from './proposal.ts';

/** 从调整里取出它引用的任务 id（goal / profile / addResource 不引用具体任务） */
export function adjustmentTaskId(a: AppliedAdjustment): string | null {
  switch (a.kind) {
    case 'reschedule':
    case 'estimate':
    case 'taskPatch':
    case 'dropTask':
      return a.taskId;
    case 'addTask':
      return a.task.id;
    case 'goal':
    case 'profile':
    case 'addResource':
      return null;
  }
}

export function describeDrift(d: Drift, titleOf: (taskId: string) => string): string {
  switch (d.kind) {
    case 'overdue':
      return `落后   「${titleOf(d.taskId)}」已过期 ${d.days} 天`;
    case 'overrun':
      return `预估低 「${titleOf(d.taskId)}」实际耗时是预估的 ${d.ratio} 倍`;
    case 'underrun':
      return `预估高 「${titleOf(d.taskId)}」实际只有预估的 ${d.ratio}`;
    case 'stalled':
      return `卡住   「${titleOf(d.taskId)}」进行中已 ${d.days} 天没动静`;
    case 'chainBlocked':
      return `连锁   「${titleOf(d.taskId)}」被未完成的「${titleOf(d.blockedBy)}」挡住`;
    case 'milestoneRisk':
      return `里程碑 ${d.milestoneId} 还差 ${Math.round(d.shortfallMin / 60)} 小时，可用只有 ${Math.round(d.capacityMin / 60)} 小时`;
    case 'budgetOver':
      return `超载   ${d.week} 排了 ${d.plannedMin} 分钟，预算 ${d.capacityMin} 分钟`;
  }
}

export function describeAdjustment(a: AppliedAdjustment, titleOf: (taskId: string) => string): string {
  switch (a.kind) {
    case 'reschedule':
      return `「${titleOf(a.taskId)}」${a.scheduledFor ? `→ ${a.scheduledFor}` : '→ 待排池'}    ${a.reason}`;
    case 'estimate':
      return `「${titleOf(a.taskId)}」预估 → ${a.estimateMin} 分钟    ${a.reason}`;
    case 'taskPatch':
      return `「${titleOf(a.taskId)}」改了 ${Object.keys(a.patch).length} 处    ${a.reason}`;
    case 'dropTask':
      return `移除「${titleOf(a.taskId)}」    ${a.reason}`;
    case 'addTask':
      return `新增「${a.task.title}」    ${a.reason}`;
    case 'goal':
      return `目标变更：${JSON.stringify(a.patch)}    ${a.reason}`;
    case 'addResource':
      return `新增资源「${a.resource.title}」    ${a.reason}`;
    case 'profile':
      return `更新档案    ${a.reason}`;
  }
}

/** 多行形式，用于终端与详情页 */
export function describeOption(o: GoalOption): string {
  return [
    `  ▸ ${o.title}`,
    `      为什么：${o.rationale}`,
    `      影响：  ${o.impact}`,
    `      后果：  ${o.consequences}`,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * 提案的行描述
 * ------------------------------------------------------------------ */

/**
 * 一张建议卡片要显示的东西。
 *
 * ## 为什么是结构而不是一句话
 *
 * 卡片上分三层：**标题**（改的是谁）、**从什么变成什么**、**为什么**。
 * 三层的排版和颜色都不一样，所以要的是结构。
 * 现有的 `describeAdjustment` 返回一行字符串，而且目标的 patch 是
 * `JSON.stringify` 出来的——那不是给学生看的东西。
 *
 * ## 谁用它
 *
 * 复盘的建议卡、「跟 AI 说说」的待确认卡、将来的调试 CLI。
 * 一处实现，三处说法一致。
 */
export type ProposalRow = {
  key: string;
  /** 改的是谁：任务标题 / 「新任务」/ 「目标」/ 「记住你的情况」 */
  title: string;
  /** 从什么变成什么。一句话，短 */
  change: string;
  /** 给学生看的理由（可能被 AI 改写得更顺） */
  reason: string;
  /** 引擎/规则原文。和 `reason` 一样时就说明没被改写 */
  engineReason: string;
  /** 这条被学生改过（调用方比出来的，不由本函数判断） */
  edited?: boolean;
};

/** '10/21 周三'；没有日期时给一句人话 */
function dayLabel(day: string | null): string {
  return day ? fmtDayWithWeekday(day) : '待排池';
}

/** 目标补丁 → 人话。每个字段一句，避免出现 JSON */
function goalPatchText(patch: GoalPatch): string {
  const parts: string[] = [];
  if (patch.statement !== undefined) parts.push(`目标改成「${patch.statement}」`);
  if (patch.deadline !== undefined) {
    parts.push(patch.deadline ? `截止日 → ${fmtMonthDay(patch.deadline)}` : '截止日 → 不限');
  }
  if (patch.priority !== undefined) {
    const zh = { low: '低', medium: '中', high: '高' } as const;
    parts.push(`优先级 → ${zh[patch.priority]}`);
  }
  if (patch.successCriteria !== undefined) parts.push(`成功标准改成 ${patch.successCriteria.length} 条`);
  return parts.join('，') || '（没有变化）';
}

/** 档案补丁 → 人话 */
function profilePatchText(patch: ProfilePatch): string {
  const parts: string[] = [];
  if (patch.weeklyHours !== undefined) {
    parts.push(patch.weeklyHours === null ? '每周可用时间 → 未说' : `每周可用 ${patch.weeklyHours} 小时`);
  }
  if (patch.level !== undefined) {
    const zh = { beginner: '刚入门', basic: '有基础', intermediate: '中等', advanced: '比较强' } as const;
    parts.push(patch.level === null ? '水平 → 未说' : `水平 → ${zh[patch.level]}`);
  }
  if (patch.weekdays !== undefined) parts.push(`可用的日子改成 ${patch.weekdays.length} 天`);
  if (patch.weakSpots !== undefined) parts.push(`薄弱点改成 ${patch.weakSpots.length} 项`);
  if (patch.goalStatement !== undefined) parts.push('目标原话');
  if (patch.deadline !== undefined) parts.push('截止日');
  return parts.join('，') || '（没有变化）';
}

/**
 * 把一条提案摊成卡片要的三层。
 *
 * `plan` 只用来查任务标题——查不到（比如任务刚被删掉）也要能画出来，
 * 所以标题退化成「（已删除的一项）」而不是抛异常。
 */
export function describeProposal(p: Proposal, plan: PlanFile): ProposalRow {
  const titleOf = (id: string) => plan.tasks.find((t) => t.id === id)?.title ?? '（已删除的一项）';
  const base = { key: proposalKey(p), reason: p.reason, engineReason: p.engineReason };

  switch (p.kind) {
    case 'reschedule': {
      const t = plan.tasks.find((x) => x.id === p.taskId);
      return {
        ...base,
        title: titleOf(p.taskId),
        change: `${t?.scheduledFor ? dayLabel(t.scheduledFor) : '待排池'} → ${dayLabel(p.scheduledFor)}`,
      };
    }
    case 'estimate': {
      const t = plan.tasks.find((x) => x.id === p.taskId);
      return {
        ...base,
        title: titleOf(p.taskId),
        change: `预估 ${fmtMinutes(t?.estimateMin ?? 0)} → ${fmtMinutes(p.estimateMin)}`,
      };
    }
    case 'task': {
      // 学生改过的卡：把补丁里每一项和他原来的值比一遍，只说变了的
      const t = plan.tasks.find((x) => x.id === p.taskId);
      const bits: string[] = [];
      const q = p.patch;
      if (q.scheduledFor !== undefined && t?.scheduledFor !== q.scheduledFor) {
        bits.push(`${t?.scheduledFor ? dayLabel(t.scheduledFor) : '待排池'} → ${dayLabel(q.scheduledFor)}`);
      }
      if (q.estimateMin !== undefined && t?.estimateMin !== q.estimateMin) {
        bits.push(`预估 ${fmtMinutes(t?.estimateMin ?? 0)} → ${fmtMinutes(q.estimateMin)}`);
      }
      if (q.title !== undefined && t?.title !== q.title) bits.push(`标题改成「${q.title}」`);
      if (q.type !== undefined && t?.type !== q.type) bits.push('类型变了');
      if (q.notes !== undefined && t?.notes !== q.notes) bits.push('备注改了');
      if (q.pinned !== undefined && t?.pinned !== q.pinned) bits.push(q.pinned ? '上锁' : '解锁');
      if (q.notBefore !== undefined && t?.notBefore !== q.notBefore) bits.push('最早可安排日变了');
      if (q.tags !== undefined) bits.push('标记改了');
      if (q.dependsOn !== undefined) bits.push('前置改了');
      if (q.resourceIds !== undefined) bits.push('资料改了');
      return { ...base, title: titleOf(p.taskId), change: bits.join(' · ') || '（和现在一样）' };
    }
    case 'dropTask':
      return { ...base, title: titleOf(p.taskId), change: '不再做了' };
    case 'addTask':
      return {
        ...base,
        title: p.task.title,
        change: `新加一张 · ${dayLabel(p.task.scheduledFor)} · ${fmtMinutes(p.task.estimateMin)}`,
      };
    case 'goal':
      return { ...base, title: '目标', change: goalPatchText(p.patch) };
    case 'profile':
      return { ...base, title: '记住你的情况', change: profilePatchText(p.patch) };
    case 'addResource':
      return { ...base, title: '资料', change: `挂上「${p.resource.title}」` };
  }
}
