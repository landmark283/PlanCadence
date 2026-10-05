/**
 * 提案（Proposal）—— 「计划该怎么变」的唯一说法。
 *
 * ## 为什么只该有一种说法
 *
 * 复盘给的是提案，跟 AI 说说给的也是提案。两边各写一套形状的话，迟早会走到
 * 「AI 能改但我改不了」或者「复盘改得了、聊天改不了」——那正是 v0.3 把字段差分
 * 收进 `task-patch.ts` 时立下的同一条规矩。
 *
 * 所以 `Proposal` **从 `AppliedAdjustment` 派生**：
 * 它多出来的只有「卡片上怎么显示」需要的字段（`reason` / `engineReason`），
 * 而**能被写进计划的种类和 `plan.applyAdjustments` 完全一致**。
 *
 * ## 模型不许碰的东西
 *
 *   · **id**：`addTask` 里没有 id 字段，id 由 `newTaskId()` 生成。
 *     沿用 `planner.ts` 的既有做法——「不让模型碰 id，它一碰就会编出重复 id」。
 *   · **日期算术**：相对日期（「周末」）由代码换算；模型给的绝对日期要过
 *     `validateProposal`（合法、不早于今天、不在 blackout、不早于 notBefore）。
 *   · **任意字段**：`goal` / `profile` 的 patch 是**显式白名单**，
 *     多给的字段在 zod 解析时就被丢掉（`z.object` 默认 strip）。
 *
 * ## 为什么 patch 不写 `.partial()`
 *
 * 通用做法是 `Goal.partial()`，但那样「允许改哪些字段」就变成隐式的
 * ——目标以后加一个字段，它就自动可改了，而没人会注意到。
 * 这里**显式列出**允许改的字段，并有一个测试盯着「它们必须是目标 schema 的子集」。
 * 这个项目已经立过一条规矩：不用 zod 版本特有的 API，显式写下来更好读。
 */
import { z } from 'zod';

import { DateStr, Id, PositiveInt, Priority, Resource, TaskType } from './schema.ts';
import type { AppliedAdjustment } from './commands.ts';
import type { PlanFile } from './schema.ts';
import { MAX_ESTIMATE_MIN, MIN_ESTIMATE_MIN } from './task-patch.ts';
import type { TaskEditPatch } from './task-patch.ts';

/* ------------------------------------------------------------------ *
 * 受白名单限制的补丁
 * ------------------------------------------------------------------ */

/**
 * 目标补丁。**显式列出**允许改的字段。
 *
 * `statement` 允许改（「甚至是修改最终目标」是明确的需求），但提示词里
 * 要求不许润色——改内容，不改语气。卡片上把 before / after 都摆出来让学生自己看。
 */
export const GoalPatch = z.object({
  statement: z.string().min(1).max(300).optional(),
  successCriteria: z.array(z.string().max(200)).max(8).optional(),
  deadline: DateStr.nullable().optional(),
  priority: Priority.optional(),
});
export type GoalPatch = z.infer<typeof GoalPatch>;

/**
 * 学生档案补丁。
 *
 * 刻意**不含 `blackouts`**：不可用日期属于 `constraints`，改它是编辑页的活，
 * 这一轮不进提案（见方案第八部分）。
 */
export const ProfilePatch = z.object({
  goalStatement: z.string().max(300).nullable().optional(),
  deadline: DateStr.nullable().optional(),
  level: z.enum(['beginner', 'basic', 'intermediate', 'advanced']).nullable().optional(),
  weeklyHours: z.number().min(0).max(40).nullable().optional(),
  weekdays: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).max(7).optional(),
  weakSpots: z.array(z.string().max(60)).max(8).optional(),
});
export type ProfilePatch = z.infer<typeof ProfilePatch>;

/**
 * 模型提议新增的任务。**不含 id**（由代码生成）。
 *
 * 也没有 `dependsOn` / `resourceIds`：新建的任务去接依赖是环的主要来源，
 * 而「让 AI 顺手连依赖」的收益远小于它带来的失败方式
 * （一条成环的依赖会让整批提案被 `validatePlan` 拒掉）。
 */
export const DraftTask = z.object({
  title: z.string().min(1).max(160),
  type: TaskType,
  estimateMin: PositiveInt,
  notes: z.string().max(2000).default(''),
  scheduledFor: DateStr.nullable().default(null),
  notBefore: DateStr.nullable().default(null),
  tags: z.array(Id).default([]),
});
export type DraftTask = z.infer<typeof DraftTask>;

/* ------------------------------------------------------------------ *
 * 提案
 * ------------------------------------------------------------------ */

/**
 * 理由。
 *
 * `reason` 是卡片上显示的那句，`engineReason` 是引擎的原文（**永远有**）。
 * 两个都有，是为了让「AI 只是把话说得更好懂，决定仍然是引擎做的」这件事
 * 在界面上可见——如果 AI 改写过，卡片上会并排显示原文。
 *
 * 不另设 `reasonSource` 字段：`reason === engineReason` 就是没改写。
 * 多一个字段就多一个会和事实对不上的地方。
 */
const Reason = {
  reason: z.string().min(1).max(300),
  engineReason: z.string().min(1).max(300),
};

/**
 * 任务字段补丁。**显式列出**，和 `task-patch.ts` 的 `TaskEditPatch` 一一对应。
 *
 * 为什么需要它：引擎给的建议是窄的（就改个日期，或者就改个时长），
 * 但**学生编辑一张卡片时会一次改好几样**——「挪到周六」顺手把预估也调了。
 * 没有这个种类的话，学生的编辑只能用「改期」或「改时长」表达，
 * 而他改的另一个字段会**静默丢掉**。
 */
export const TaskPatchSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  notes: z.string().max(2000).optional(),
  type: TaskType.optional(),
  tags: z.array(Id).optional(),
  estimateMin: PositiveInt.optional(),
  scheduledFor: DateStr.nullable().optional(),
  pinned: z.boolean().optional(),
  notBefore: DateStr.nullable().optional(),
  dependsOn: z.array(Id).optional(),
  resourceIds: z.array(Id).optional(),
});
/** 编译期的相等性检查：这个 schema 推出来的类型必须就是 `TaskEditPatch` */
export type TaskPatchSchemaOutput = z.infer<typeof TaskPatchSchema>;
const _patchMatches: TaskEditPatch extends TaskPatchSchemaOutput ? true : never = true;
void _patchMatches;

export const Proposal = z.discriminatedUnion('kind', [
  /** 改期。`scheduledFor: null` = 移回待排池 */
  z.object({ kind: z.literal('reschedule'), taskId: Id, scheduledFor: DateStr.nullable(), ...Reason }),
  z.object({ kind: z.literal('estimate'), taskId: Id, estimateMin: PositiveInt, ...Reason }),
  /** 学生把一张建议卡改过之后：一次改好几个字段 */
  z.object({ kind: z.literal('task'), taskId: Id, patch: TaskPatchSchema, ...Reason }),
  /** 改目标（局部或最终目标） */
  z.object({ kind: z.literal('goal'), patch: GoalPatch, ...Reason }),
  /** 加一项。id 由代码补 */
  z.object({ kind: z.literal('addTask'), task: DraftTask, ...Reason }),
  /** 删一项 */
  z.object({ kind: z.literal('dropTask'), taskId: Id, ...Reason }),
  z.object({ kind: z.literal('addResource'), resource: Resource, ...Reason }),
  /** 改学生档案：他说「我每周只有 3 小时了」，要改的不只是计划里的数字 */
  z.object({ kind: z.literal('profile'), patch: ProfilePatch, ...Reason }),
]);
export type Proposal = z.infer<typeof Proposal>;
export type ProposalKind = Proposal['kind'];

/**
 * 提案的稳定键。
 *
 * 界面要用它做 React key、记录「哪几条被划掉了」「哪几条被改过」。
 * **不能用数组下标**：划掉一条之后后面的全都会错位。
 * 也不能用 `taskId`：同一项任务可能同时有「改期」和「调时长」两条提案。
 */
export function proposalKey(p: Proposal): string {
  switch (p.kind) {
    case 'reschedule':
    case 'estimate':
    case 'task':
    case 'dropTask':
      return `${p.kind}:${p.taskId}`;
    case 'addTask':
      // 新任务还没有 id，用标题——同一个 session 里标题重复的概率可以忽略，
      // 而且真重复了也只是两条卡共用一个 key，不会写错计划
      return `addTask:${p.task.title}`;
    case 'goal':
      return 'goal';
    case 'profile':
      return 'profile';
    case 'addResource':
      return `addResource:${p.resource.id}`;
  }
}

/** 这条提案改的是哪一项任务（不引用任务的返回 null）。卡片上要用它查标题 */
export function proposalTaskId(p: Proposal): string | null {
  switch (p.kind) {
    case 'reschedule':
    case 'estimate':
    case 'task':
    case 'dropTask':
      return p.taskId;
    case 'addTask':
      return null;
    case 'goal':
    case 'profile':
    case 'addResource':
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * 校验：模型提议，代码把关
 * ------------------------------------------------------------------ */

export type ProposalCheck = { ok: true } | { ok: false; reason: string };

const OK: ProposalCheck = { ok: true };

/**
 * 一条提案能不能落地。**失败理由要写给学生看**，所以是人话。
 *
 * 调用点在服务端（模型返回之后），但它是纯函数，所以单测能直接打它。
 * 校验失败的那条会被**丢掉并说明原因**，其余照常——一条坏提议不该让整批作废。
 */
export function validateProposal(p: Proposal, plan: PlanFile, today: string): ProposalCheck {
  const task = (id: string) => plan.tasks.find((t) => t.id === id) ?? null;

  switch (p.kind) {
    case 'reschedule': {
      const t = task(p.taskId);
      if (!t) return { ok: false, reason: `计划里没有这一项了` };
      if (p.scheduledFor === null) return OK; // 移回待排池永远合法
      if (p.scheduledFor < today) return { ok: false, reason: `「${t.title}」不能排到已经过去的日子` };
      for (const b of plan.constraints.blackouts) {
        if (p.scheduledFor >= b.from && p.scheduledFor <= b.to) {
          const span = b.reason ?? `${b.from}~${b.to}`;
          return { ok: false, reason: `算出来的日期落在你说的不可用区间「${span}」里` };
        }
      }
      if (t.notBefore && p.scheduledFor < t.notBefore) {
        return { ok: false, reason: `「${t.title}」你设过「最早 ${t.notBefore} 才能排」` };
      }
      return OK;
    }
    case 'estimate': {
      const t = task(p.taskId);
      if (!t) return { ok: false, reason: `计划里没有这一项了` };
      if (p.estimateMin < MIN_ESTIMATE_MIN || p.estimateMin > MAX_ESTIMATE_MIN) {
        return { ok: false, reason: `时长 ${p.estimateMin} 分钟超出了可设范围` };
      }
      return OK;
    }
    case 'task': {
      const t = task(p.taskId);
      if (!t) return { ok: false, reason: `计划里没有这一项了` };
      if (Object.keys(p.patch).length === 0) return { ok: false, reason: '这条没说要改什么' };
      if (p.patch.estimateMin !== undefined) {
        if (p.patch.estimateMin < MIN_ESTIMATE_MIN || p.patch.estimateMin > MAX_ESTIMATE_MIN) {
          return { ok: false, reason: `时长 ${p.patch.estimateMin} 分钟超出了可设范围` };
        }
      }
      // 日期用和「改期」同一套判断，不另写一份
      if (p.patch.scheduledFor) {
        return validateProposal(
          { kind: 'reschedule', taskId: p.taskId, scheduledFor: p.patch.scheduledFor, reason: p.reason, engineReason: p.engineReason },
          plan,
          today
        );
      }
      return OK;
    }
    case 'dropTask':
      return task(p.taskId) ? OK : { ok: false, reason: `计划里没有这一项了` };
    case 'addTask': {
      if (p.task.estimateMin < MIN_ESTIMATE_MIN || p.task.estimateMin > MAX_ESTIMATE_MIN) {
        return { ok: false, reason: `时长 ${p.task.estimateMin} 分钟超出了可设范围` };
      }
      if (p.task.scheduledFor !== null && p.task.scheduledFor < today) {
        return { ok: false, reason: '新任务不能排到已经过去的日子' };
      }
      return OK;
    }
    case 'goal': {
      if (p.patch.deadline && p.patch.deadline < today) {
        return { ok: false, reason: '目标的截止日不能是过去的日期' };
      }
      if (Object.keys(p.patch).length === 0) return { ok: false, reason: '这条没说要改什么' };
      return OK;
    }
    case 'profile': {
      if (Object.keys(p.patch).length === 0) return { ok: false, reason: '这条没说要改什么' };
      return OK;
    }
    case 'addResource':
      return OK;
  }
}

/* ------------------------------------------------------------------ *
 * 落地：提案 → 命令载荷
 * ------------------------------------------------------------------ */

/**
 * 把提案变成 `plan.applyAdjustments` 要的载荷。
 *
 * `newId` 只在 `addTask` 时用到——它是 `newTaskId()` 算出来的，
 * 由调用方传进来（而不是在这里读时钟或随机数），保持本函数是纯函数。
 */
export function toAppliedAdjustment(p: Proposal, newId?: string): AppliedAdjustment {
  switch (p.kind) {
    case 'reschedule':
      return { kind: 'reschedule', taskId: p.taskId, scheduledFor: p.scheduledFor, reason: p.reason };
    case 'estimate':
      return { kind: 'estimate', taskId: p.taskId, estimateMin: p.estimateMin, reason: p.reason };
    case 'task':
      return { kind: 'taskPatch', taskId: p.taskId, patch: p.patch, reason: p.reason };
    case 'goal':
      return { kind: 'goal', patch: p.patch, reason: p.reason };
    case 'addTask': {
      if (!newId) throw new Error('addTask 提案落地时必须给一个 id');
      return {
        kind: 'addTask',
        task: {
          id: newId,
          title: p.task.title,
          type: p.task.type,
          estimateMin: p.task.estimateMin,
          notes: p.task.notes,
          scheduledFor: p.task.scheduledFor,
          notBefore: p.task.notBefore,
          tags: p.task.tags,
        },
        reason: p.reason,
      };
    }
    case 'dropTask':
      return { kind: 'dropTask', taskId: p.taskId, reason: p.reason };
    case 'addResource':
      return { kind: 'addResource', resource: p.resource, reason: p.reason };
    case 'profile':
      return { kind: 'profile', patch: p.patch as Record<string, unknown>, reason: p.reason };
  }
}
