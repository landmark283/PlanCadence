/**
 * 把「新增的东西」交给引擎排出具体日期。
 *
 * ## 为什么需要这一步
 *
 * 一个刚加进来的目标，它的任务是没有日期的（`scheduledFor: null`）。
 * 而「排期」是这个产品唯一不能交给模型算的东西：哪天装得下、有没有撞上
 * 不可用区间、前置做完没有，全都要可复现、可解释。所以新增目标之后必须
 * **回头调一次引擎**（`proposeReschedule`），否则学生拿到的是一个目标加一堆
 * 待排池里的任务——那不叫排期，那叫许愿。
 *
 * ## 为什么日期是**填回那张卡**，而不是另出一批卡片
 *
 * 一个目标带 4 项任务，如果排期另出 4 张卡，学生就能「留下 4 张排期卡、
 * 划掉那个目标」——而那些任务的 id 是随目标一起生成的，划掉目标之后它们
 * 根本不存在，整条命令会因为「未找到任务」被拒。
 * 把日期填回**同一条提案**，划掉目标就是划掉它的一切，不存在半截状态。
 * 卡片数也保持在「一次新增 = 一张卡」这个量级。
 *
 * ## 做法：投影 → 跑引擎 → 写回日期
 *
 * 把提案应用到一个**副本**上（复用 `applyCommand`，所以校验和真实写入完全一致），
 * 在副本上跑引擎，再把算出来的日期写回提案里的任务。**只处理新增的任务**——
 * 已有任务的挪动是复盘那一屏的事，不该在「加一条新线」这一步里顺手发生。
 */
import { applyCommand } from './commands.ts';
import { allocateIds, proposalKey, toAppliedAdjustment } from './proposal.ts';
import { proposeReschedule, rescheduleHorizon } from './engine.ts';
import type { PlanFile } from './schema.ts';
import type { Proposal } from './proposal.ts';

/**
 * 给提案里新增的任务排出日期，返回一批**同样条数、同样顺序**的提案。
 *
 * 没有任何可排的新任务时原样返回。副本应用失败时也原样返回——
 * 那说明提案本身有问题，而 `validateProposal` 已经在更早的一层拦过并给过理由，
 * 这里再抛一次只会把那句理由盖掉。
 */
export function placeNewTasks(plan: PlanFile, proposals: readonly Proposal[], today: string): Proposal[] {
  const additions = proposals.filter((p) => p.kind === 'addMilestone' || p.kind === 'addTask');
  if (!additions.length) return [...proposals];

  const ids = allocateIds(plan, proposals);
  const applied = proposals.map((p) => toAppliedAdjustment(p, ids.get(proposalKey(p))));

  const projected = applyCommand(plan, {
    type: 'plan.applyAdjustments',
    // 时间戳只进副本的 history，不会被写回，所以用原计划的更新时间即可
    at: plan.meta.updated,
    applied,
  });
  if (!projected.ok) return [...proposals];

  const placed = new Map<string, string | null>();
  for (const a of proposeReschedule(projected.plan, today, {
    horizonDays: rescheduleHorizon(projected.plan, today),
  })) {
    if (a.kind === 'reschedule') placed.set(a.taskId, a.scheduledFor);
  }
  if (!placed.size) return [...proposals];

  /**
   * 写回。提案里任务的顺序和 `allocateIds` 给的 `taskIds` 一一对应，
   * 所以按下标取就行——不需要（也不可能）按标题匹配。
   */
  const out: Proposal[] = [];
  for (const p of proposals) {
    if (p.kind === 'addTask') {
      const id = ids.get(proposalKey(p))?.task;
      const to = id ? placed.get(id) : undefined;
      out.push(to === undefined ? p : { ...p, task: { ...p.task, scheduledFor: to } });
      continue;
    }
    if (p.kind === 'addMilestone') {
      const taskIds = ids.get(proposalKey(p))?.milestone?.taskIds ?? [];
      const tasks = p.tasks.map((t, i) => {
        const to = placed.get(taskIds[i] ?? '');
        return to === undefined ? t : { ...t, scheduledFor: to };
      });
      out.push({ ...p, tasks });
      continue;
    }
    out.push(p);
  }
  return out;
}
