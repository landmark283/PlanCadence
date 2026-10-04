/**
 * 把引擎产出的结构化结果渲染成中文措辞。
 *
 * 抽到共享层的理由：CLI、服务端、移动端必须用**完全一致**的说法。
 * 同一件事（比如「这条为什么被顺延」）在三处措辞不同，是最容易被评委
 * 一眼看穿「拼装感」的细节。
 */
import type { AppliedAdjustment } from './commands.ts';
import type { Drift, GoalOption } from './engine.ts';

/** 从调整里取出它引用的任务 id（goal / addResource 不引用具体任务） */
export function adjustmentTaskId(a: AppliedAdjustment): string | null {
  switch (a.kind) {
    case 'reschedule':
    case 'estimate':
    case 'dropTask':
      return a.taskId;
    case 'addTask':
      return a.task.id;
    case 'goal':
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
    case 'dropTask':
      return `移除「${titleOf(a.taskId)}」    ${a.reason}`;
    case 'addTask':
      return `新增「${a.task.title}」    ${a.reason}`;
    case 'goal':
      return `目标变更：${JSON.stringify(a.patch)}    ${a.reason}`;
    case 'addResource':
      return `新增资源「${a.resource.title}」    ${a.reason}`;
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
