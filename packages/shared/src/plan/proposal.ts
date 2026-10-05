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

import { DateStr, Id, MilestoneStatus, PositiveInt, Priority, Resource, TaskType } from './schema.ts';
import { newCompetenceId, newMilestoneId, newTaskId } from './ids.ts';
import type { AppliedAdjustment } from './commands.ts';
import type { MilestoneEditPatch, PlanFile } from './schema.ts';
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
  /**
   * 新任务**不预设标记**，所以这里对模型给的 tags 一律宽容地丢掉。
   *
   * ## 为什么用 `.catch([])` 而不是老老实实校验
   *
   * 这一条是**真机实测撞出来的**，代价很大：模型兴冲冲地给一个新增目标
   * 写了 6 条很不错的任务，每条都带 `tags: ["搜索"]`（它把标记理解成了**话题名**），
   * 而 `Task.tags` 存的是**标记目录的 id**（`^[a-z][a-z0-9_]{0,31}$`）。
   * 于是整条 `addMilestone` 提案 schema 不过 → **一个目标连带 6 条任务全没了**，
   * 而且当时那一层只计数、不报原因，界面上什么都不显示。
   *
   * 一个装饰性的标记不该有这种杀伤半径。`.catch` 把损失限制在它自己身上：
   * 标签丢掉，目标和任务照常进来。
   *
   * ## 为什么干脆不保留合法的那些
   *
   * 本地生成路径早就有定论（见 `llm/planner.ts`）：**标记由学生自己打，
   * 生成时不预设**——系统猜不出「这题我错了好几次」这种事，而猜错一次标记
   * 比不打标记更烦人（学生得先删掉再打自己的）。模型能给出的「标记」
   * 十有八九是话题名，留着只会污染标记目录。
   */
  tags: z.array(Id).max(6).catch([]).default([]),
});
export type DraftTask = z.infer<typeof DraftTask>;

/* ------------------------------------------------------------------ *
 * 目标（= 里程碑）
 * ------------------------------------------------------------------ */

/**
 * 「目标」在数据里就是**里程碑**，不另开一个数组。
 *
 * ## 为什么不给 `PlanFile` 加一个 `goals[]`
 *
 * 里程碑已经长着一个目标该有的全部东西：名字（`title`）、截止日（`due`）、
 * 成功判据（`criteria`）、挂的能力点（`competenceIds`）、状态（`status`）。
 * 而引擎**从头到尾没有读过 `plan.goal`**——它按 `tasks` / `milestones` /
 * `competences` / `constraints` 干活，排期时按「所属里程碑的截止日」排序，
 * 也逐里程碑算「还来不来得及」。也就是说**多目标这件事在引擎里早就是成立的**，
 * 缺的只是「怎么新增/修改一个目标」这条表达。
 *
 * 加一个 `goals[]` 的代价是把同一件事写两遍（里程碑和目标各自带截止日、
 * 各自挂能力点），而这个项目已经因为「两份真相」吃过两次亏
 * （见 `docs/技术方案.md` §9.15 ⑧）。语义上也站得住：学生说的「最终目标」
 * 是一句话，而赛事/考试是**几条并行的线**——那正是里程碑。
 *
 * 于是：`PlanFile.goal` 保持「总目标」那**一句话**（学生原话，复盘页要原样回显），
 * 多个目标住在 `milestones[]` 里，每个有自己的截止日。
 */
export const MilestonePatch = z.object({
  title: z.string().min(1).max(120).optional(),
  due: DateStr.nullable().optional(),
  criteria: z.array(z.string().max(200)).optional(),
  status: MilestoneStatus.optional(),
});
export type MilestonePatch = z.infer<typeof MilestonePatch>;

/**
 * 编译期的相等性检查：这个 schema 推出来的类型必须就是 `MilestoneEditPatch`。
 *
 * 和 `TaskPatchSchema` 那一处同样的道理——命令层的白名单和这里各写一遍，
 * 迟早会只剩一边。有了这一行，加字段时漏掉任何一边都过不了类型检查。
 */
const _msPatchMatches: MilestoneEditPatch extends MilestonePatch ? true : never = true;
void _msPatchMatches;

/**
 * 模型提议新增的一个目标。**不含 id**（由代码生成）。
 *
 * `competences` 只给**名字**，id 与 target 由代码补——和 `DraftTask` 不含 id
 * 是同一个理由：模型碰 id 就会造出悬空引用。
 */
export const DraftMilestone = z.object({
  title: z.string().min(1).max(120),
  due: DateStr.nullable().default(null),
  criteria: z.array(z.string().max(200)).max(8).default([]),
  /** 这个目标要练的能力点（名字）。空数组合法：先立目标再想练什么 */
  competences: z.array(z.string().min(1).max(80)).max(8).default([]),
});
export type DraftMilestone = z.infer<typeof DraftMilestone>;


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
  /**
   * 改一个**目标**（里程碑）：挪它自己的截止日、改判据、改名、收尾。
   *
   * 存在的理由是一个真实的错：复盘检测到的是「某个里程碑来不及」，
   * 但当时给出的卡片改的是**总目标的截止日**（`goal.deadline + 14`）。
   * 总目标在明年四月、而紧的是十一月底的那个赛事时，那张卡什么都没解决，
   * 却写着「里程碑可能赶不上」——比不给卡更坏。
   */
  z.object({ kind: z.literal('milestone'), milestoneId: Id, patch: MilestonePatch, ...Reason }),
  /**
   * 新增一个目标，**并带上它的任务**。
   *
   * 为什么任务要一起给：一个没有任务的目标排不进任何时间，复盘也无从谈起。
   * 而如果拆成「先加目标、再加任务」两条提案，任务就得自己带 `milestoneId`——
   * 那正是模型最容易编错的地方（悬空引用）。放成一条，连线由代码建。
   */
  z.object({ kind: z.literal('addMilestone'), milestone: DraftMilestone, tasks: z.array(DraftTask).max(12).default([]), ...Reason }),
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
    case 'milestone':
      return `milestone:${p.milestoneId}`;
    case 'addMilestone':
      // 和 addTask 同理：还没有 id，用标题
      return `addMilestone:${p.milestone.title}`;
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
    case 'milestone':
    case 'addMilestone':
      return null;
  }
}

/**
 * 给一批提案里的**新增对象**分配 id。纯函数。
 *
 * ## 为什么要有它，而不是让每个调用方自己 `newTaskId()`
 *
 * 「新增目标」要三种 id：里程碑的、它挂的每个能力点的、它带的每个任务的。
 * 而 **`placeNewTasks()` 要拿这些 id 去投影一份计划跑引擎**，
 * 界面在真正写入时又要再用一次——两处必须算出**完全相同**的 id，
 * 否则引擎排好日期的那个任务和最后写进计划的任务是两个东西。
 *
 * 所以分配只有这一个实现：两边都拿同一份 `plan + proposals` 去调它，
 * 结果由构造保证一致（都是纯函数，都不读时钟和随机数）。
 * 同一个批次里多条提案的 id 也不会撞——分配出来的 id 会立刻并进
 * 已用集合，下一条接着往后取。
 */
export function allocateIds(plan: PlanFile, proposals: readonly Proposal[]): Map<string, NewIds> {
  const taskIds = plan.tasks.map((t) => t.id);
  const msIds = plan.milestones.map((m) => m.id);
  const compIds = plan.competences.map((c) => c.id);
  const out = new Map<string, NewIds>();

  for (const p of proposals) {
    if (p.kind === 'addTask') {
      const id = newTaskId(taskIds);
      taskIds.push(id);
      out.set(proposalKey(p), { task: id });
      continue;
    }
    if (p.kind !== 'addMilestone') continue;
    const id = newMilestoneId(msIds);
    msIds.push(id);
    const competenceIds = p.milestone.competences.map(() => {
      const cid = newCompetenceId(compIds);
      compIds.push(cid);
      return cid;
    });
    const ids = p.tasks.map(() => {
      const tid = newTaskId(taskIds);
      taskIds.push(tid);
      return tid;
    });
    out.set(proposalKey(p), { milestone: { id, competenceIds, taskIds: ids } });
  }
  return out;
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
    case 'milestone': {
      const m = plan.milestones.find((x) => x.id === p.milestoneId);
      if (!m) return { ok: false, reason: '计划里没有这个目标了' };
      if (Object.keys(p.patch).length === 0) return { ok: false, reason: '这条没说要改什么' };
      if (p.patch.due && p.patch.due < today) {
        return { ok: false, reason: `「${m.title}」的截止日不能是过去的日期` };
      }
      return OK;
    }
    case 'addMilestone': {
      const title = p.milestone.title.trim();
      if (!title) return { ok: false, reason: '新目标没有名字' };
      /**
       * 重名要拦：里程碑在界面上是用**标题**认人的（卡片、事实、方向都说名字），
       * 两个同名的目标一出现，学生就分不清哪张卡改的是哪一个。
       */
      const dup = plan.milestones.find((x) => x.title.trim() === title);
      if (dup) return { ok: false, reason: `已经有一个叫「${title}」的目标了` };
      if (p.milestone.due && p.milestone.due < today) {
        return { ok: false, reason: `新目标「${title}」的截止日不能是过去的日期` };
      }
      for (const t of p.tasks) {
        if (t.estimateMin < MIN_ESTIMATE_MIN || t.estimateMin > MAX_ESTIMATE_MIN) {
          return { ok: false, reason: `「${t.title}」的时长 ${t.estimateMin} 分钟超出了可设范围` };
        }
        if (t.scheduledFor !== null && t.scheduledFor < today) {
          return { ok: false, reason: `「${t.title}」不能排到已经过去的日子` };
        }
      }
      if (Object.keys(p.milestone).length === 0) return { ok: false, reason: '这条没说要改什么' };
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
 * 新对象的 id。**由调用方算好传进来**（而不是在这里读时钟或随机数），
 * 这样本函数保持纯函数、可以被单测直接打。
 *
 * `addMilestone` 要三种 id：里程碑自己的、它挂的每个能力点的、以及它带的每个任务的
 * （`taskIds` 与提案里的 `tasks` **按下标一一对应**）。
 */
export type NewIds = {
  /** `addTask` 用 */
  task?: string;
  /** `addMilestone` 用 */
  milestone?: { id: string; competenceIds: string[]; taskIds: string[] };
};

/** 一个目标练到什么程度算会。和 planner 的本地路径一致（`target: 0.8`） */
const DEFAULT_COMPETENCE_TARGET = 0.8;

/**
 * 把提案变成 `plan.applyAdjustments` 要的载荷。
 *
 * 缺 id 就抛：这不是「学生输错了」，是**调用方的编程错误**——
 * 悄悄用一个空 id 建出一条 id 为空的里程碑，会让整份计划下一次解析就失败。
 */
export function toAppliedAdjustment(p: Proposal, ids: NewIds = {}): AppliedAdjustment {
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
      if (!ids.task) throw new Error('addTask 提案落地时必须给一个 id');
      return {
        kind: 'addTask',
        task: {
          id: ids.task,
          title: p.task.title,
          type: p.task.type,
          estimateMin: p.task.estimateMin,
          notes: p.task.notes,
          scheduledFor: p.task.scheduledFor,
          notBefore: p.task.notBefore,
          tags: p.task.tags,
          milestoneId: null,
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
    case 'milestone':
      return { kind: 'milestone', milestoneId: p.milestoneId, patch: p.patch, reason: p.reason };
    case 'addMilestone': {
      const alloc = ids.milestone;
      if (!alloc) throw new Error('addMilestone 提案落地时必须给里程碑 id');
      if (alloc.taskIds.length !== p.tasks.length) {
        throw new Error(`addMilestone 需要 ${p.tasks.length} 个任务 id，收到 ${alloc.taskIds.length} 个`);
      }
      if (alloc.competenceIds.length !== p.milestone.competences.length) {
        throw new Error(
          `addMilestone 需要 ${p.milestone.competences.length} 个能力点 id，收到 ${alloc.competenceIds.length} 个`
        );
      }
      return {
        kind: 'addMilestone',
        milestone: {
          id: alloc.id,
          title: p.milestone.title,
          due: p.milestone.due,
          criteria: p.milestone.criteria,
          status: 'active',
          competenceIds: [...alloc.competenceIds],
        },
        competences: p.milestone.competences.map((name, i) => ({
          id: alloc.competenceIds[i]!,
          name,
          target: DEFAULT_COMPETENCE_TARGET,
          // 新目标的能力点从 0 开始：系统对孩子现在会多少一无所知，
          // 给个「中等」是在编事实。证据链为空时界面会显示「还没有证据」。
          current: 0,
          evidence: [],
        })),
        tasks: p.tasks.map((t, i) => ({
          id: alloc.taskIds[i]!,
          title: t.title,
          type: t.type,
          estimateMin: t.estimateMin,
          notes: t.notes,
          scheduledFor: t.scheduledFor,
          notBefore: t.notBefore,
          tags: t.tags,
          // 连线在这里建，模型碰不到
          milestoneId: alloc.id,
        })),
        reason: p.reason,
      };
    }
  }
}
