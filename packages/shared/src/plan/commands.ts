/**
 * 命令层 —— 计划文件唯一的变更入口。
 *
 * 铁律：
 *  1. 任何状态变更都必须走 applyCommand，前端不允许直接改 plan 对象。
 *  2. applyCommand 是纯函数：不读时钟、不读网络、不读随机数。所有时间从 cmd.at 传入。
 *  3. 这一层的目标是「AI 能自己写单测自证正确」，因此必须无副作用、可回放。
 *
 * 回滚不靠重放命令，靠 versions/ 目录里的整份快照。命令历史只用于展示和调试。
 */
import { Task, Resource, Milestone, Competence, validatePlan, clonePlan, SCHEMA_ID } from './schema.ts';
import type {
  PlanFile,
  TaskStatus,
  TaskInput,
  ResourceInput,
  MilestoneInput,
  CompetenceInput,
  MilestoneEditPatch,
  HistoryEntry,
} from './schema.ts';
import type { TaskEditPatch } from './task-patch.ts';

/* ------------------------------------------------------------------ *
 * 命令定义
 * ------------------------------------------------------------------ */

export type Command =
  | { type: 'task.setStatus'; at: string; taskId: string; status: TaskStatus; actualMin?: number; difficulty?: number }
  | { type: 'task.setEstimate'; at: string; taskId: string; estimateMin: number }
  | { type: 'task.reschedule'; at: string; taskId: string; scheduledFor: string | null; pin?: boolean }
  /** 解锁/上锁：pinned 的任务不会被引擎自动挪动 */
  | { type: 'task.setPinned'; at: string; taskId: string; pinned: boolean }
  /** 设置「最早可安排日」：学生表达「这门等考完再说」 */
  | { type: 'task.setNotBefore'; at: string; taskId: string; notBefore: string | null }
  /**
   * 改一条任务的内容。
   *
   * ## 为什么 patch 这么宽
   *
   * 编辑页一次保存要改好几个字段（标题 + 备注 + 日期 + 标记）。如果每个字段
   * 各发一条命令，中间任何一条被拒（字段非法、前置成环）都会让前面几条**已经生效**，
   * 而**现在没有版本管理可以整体退回去**——学生看到的是「标题改了、日期没改」，
   * 得自己想起来改了哪几处、各自原来是什么。一条命令则是要么全成要么全不成。
   *
   * 顺带两个次要理由：一次编辑在 history 里变成四行，回放时看不出这是一次动作；
   * 以及一次编辑会打四遍写盘和四份 `versions/` 快照。
   *
   * ## 为什么不含 status / actualMin / difficulty
   *
   * 那三个是勾选框的业务（`task.setStatus`）。`components/task-card.tsx` 的文件头
   * 写着「完成只走勾选框，避免两个入口改同一个字段」，而 `task.setStatus`
   * 还挡着「前置未完成不许标完成」——搬进来就是同一件事的第二个实现。
   *
   * ## `scheduledFor` 和 `pinned` 的默认值
   *
   * 这里**不替学生猜**：patch 里有什么就写什么。界面上「手动改期默认上锁」
   * 那条规则在 `task-patch.ts` 的 `withScheduledFor` 里，那里是纯函数、有测试。
   */
  | { type: 'task.edit'; at: string; taskId: string; patch: TaskEditPatch }
  | { type: 'task.add'; at: string; task: TaskInput }
  | { type: 'task.remove'; at: string; taskId: string }
  | { type: 'goal.update'; at: string; patch: Partial<PlanFile['goal']> }
  | { type: 'constraints.update'; at: string; patch: Partial<PlanFile['constraints']> }
  | { type: 'competence.update'; at: string; competenceId: string; current: number; evidenceTaskId?: string }
  | { type: 'resource.add'; at: string; resource: ResourceInput }
  /**
   * 工具调用：一次把检索到的资料和它在任务上的挂载点写进去。
   *
   * 为什么不复用 `resource.add` + `task.edit` 循环：那样「找一次资料」会产生
   * 十几条 history、十几次快照，而且中途失败会留下**挂了一半**的状态——
   * 资源进来了但没挂到任务上，学生看到一堆不知道给谁用的链接。
   * 检索是一次动作，就应该是**一条历史、一次快照、要么全成要么全不成**。
   *
   * **幂等**：已有的资源 id 会跳过，已有的挂载会合并。
   * 学生连点两次「找资料」不该报错，也不该出现重复条目。
   */
  | {
      type: 'plan.attachResources';
      at: string;
      resources: ResourceInput[];
      /** 任务 → 资源 id。只接受在本次之后确实存在的资源 */
      links: { taskId: string; resourceIds: string[] }[];
    }
  /** 复盘：一次性把一批调整写回（学生在协商页逐条接受后） */
  | { type: 'plan.applyAdjustments'; at: string; applied: AppliedAdjustment[]; review?: PlanFile['reviews'][number] }
  /**
   * 回归补账：学生隔了若干天再打开时，把这段时间的账对齐。
   *
   * 为什么是**一条**命令而不是十几条：每一项各发一条会得到十几个版本号、
   * 十几个快照，版本历史变成一屏看不出这是一次结算的行；更要命的是
   * **一次回滚回不到整批之前**——学生发现结账错了，得回滚十几次，
   * 中间任何一次失败都会停在半路。这和 `plan.attachResources` 当初
   * 被做成一条命令而不是「resource.add + task.edit 循环」是同一个论证。
   *
   * 命令层在这里**只应用调用方陈述的事实，不自己判断哪些任务受影响**。
   * 「哪些任务落在结算区间内」由 `settleFacts` 算，算完以 `pending` 传进来。
   * 如果这里再算一遍，同一件事就有两个实现，两边口径迟早会不一样。
   */
  | {
      type: 'plan.settle';
      at: string;
      /** 结算覆盖的日期区间，用于历史里说清「这几天」 */
      from: string;
      to: string;
      /** 区间内本该完成但没做的。`carry` 只作用于这些 */
      pending: string[];
      /** 学生勾了「其实我做了」的 */
      done: string[];
      /** 学生勾了「放弃」的 */
      skipped: string[];
      carry: SettleCarry;
      /** `compress` 时由调用方（引擎）算好的排期；其余情况留空 */
      reschedule?: { taskId: string; scheduledFor: string | null }[];
      /** 顺带留一条复盘记录 */
      review: PlanFile['reviews'][number];
    }
  /** 回滚：从快照恢复，调用方负责提供目标版本的完整计划 */
  | { type: 'plan.restore'; at: string; snapshot: PlanFile };

/** 补账时「那批没做的怎么办」 */
export type SettleCarry =
  /** 放回待排池，重新排 */
  | 'backlog'
  /** 压缩到接下来几天（排期由调用方用引擎算好） */
  | 'compress'
  /** 先不动，学生自己安排。**仍然写一条记录**——「我看到了，我决定不管」本身是个决定 */
  | 'hold';

/** 协商页里被学生接受的单条调整 */
export type AppliedAdjustment =
  | { kind: 'reschedule'; taskId: string; scheduledFor: string | null; reason: string }
  | { kind: 'estimate'; taskId: string; estimateMin: number; reason: string }
  /**
   * 一次改任务的好几个字段。
   *
   * 存在的理由：引擎给的建议是窄的（就改日期、或就改时长），
   * 但**学生编辑一张建议卡时会一次改好几样**。没有这个种类，
   * 学生改的第二个字段会**静默丢掉**——而这正是「界面说改了、实际没变」的老毛病。
   */
  | { kind: 'taskPatch'; taskId: string; patch: TaskEditPatch; reason: string }
  | { kind: 'goal'; patch: Partial<PlanFile['goal']>; reason: string }
  | { kind: 'addTask'; task: TaskInput; reason: string }
  | { kind: 'dropTask'; taskId: string; reason: string }
  | { kind: 'addResource'; resource: ResourceInput; reason: string }
  /**
   * 改学生档案。
   *
   * 它**属于这里**，因为 `plan.profile` 本来就是计划文件的一部分：
   * 一次复盘可能同时改任务和档案（「我每周只有 3 小时了」），
   * 走两条路就不是原子的——中间失败会留下「计划改了、系统对他的认识没改」。
   *
   * `patch` 的类型刻意是 `Record<string, unknown>`：**字段白名单的校验发生在
   * `proposal.ts` 的 `ProfilePatch`**（模型输出进来的那一刻），
   * 所以到这一层时它已经是合法的。命令层不必为此反向依赖 `llm` 层。
   */
  | { kind: 'profile'; patch: Record<string, unknown>; reason: string }
  /**
   * 改一个**目标**（里程碑）：挪它自己的截止日、改判据、改名、收尾。
   *
   * 和 `goal` 分开是必须的：`goal` 改的是那句总目标 + 总截止日，
   * 而多目标场景下真正要动的是**某一条线**的截止日。合成一种的话，
   * 「把蓝桥杯那条线挪到十二月中」就没法表达。
   */
  | { kind: 'milestone'; milestoneId: string; patch: MilestoneEditPatch; reason: string }
  /**
   * 新增一个目标，连同它的能力点和任务，**一次建完**。
   *
   * 必须是一条命令而不是三条：`addMilestone` → `addCompetence` → `addTask`
   * 中间任何一步被拒，都会留下一个「有目标但没任务」或「有任务但目标不存在」的计划。
   * 而 `validatePlan` 对悬空 `milestoneId` 是 error——那会让下一次启动读不出文件。
   * 一条命令保证要么全成要么全不成。
   */
  | {
      kind: 'addMilestone';
      milestone: MilestoneInput;
      competences: CompetenceInput[];
      tasks: TaskInput[];
      reason: string;
    };

/* ------------------------------------------------------------------ *
 * 结果类型
 * ------------------------------------------------------------------ */

export type ApplyResult =
  | { ok: true; plan: PlanFile; warnings: string[] }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ *
 * 执行
 * ------------------------------------------------------------------ */

export function applyCommand(plan: PlanFile, cmd: Command): ApplyResult {
  /**
   * 【这里曾经有一条】`if (cmd.at < plan.meta.updated) return 拒绝`。
   *
   * 删掉了，理由值得写下来免得有人再加回去：
   *
   * 它的目的是防止乱序写入把 version 推回去。代价是**逼着「命令时间」必须真实递增**，
   * 于是必须养一个假时钟（从一个写死的演示日期起步的单调游标），
   * 因为示例计划的时间是演示口径，真实系统时间早于它，每一条命令都会被这条规则挡掉——
   * 界面表现就是「点了没反应」，而且看不出原因。
   *
   * 而**现在没有任何地方真的需要它**：
   *   · 客户端 `apply` 是同步 reducer，`state.plan` 顺序传递，两条命令不可能并发；
   *   · 服务端生成的计划走的是 `installPlan`，直接替换整份计划，
   *     **根本不经过这里**——这条守卫从来没有保护过它。
   *
   * 所以是删掉，而不是换一个替代品（比如命令带 `expectVersion`）：
   * 当前架构里没有第二个写者，加了就是一个永远不会被触发的字段，
   * 而永远不会被触发的代码最容易腐烂。
   *
   * 删掉之后 `cmd.at` 变成一个**纯粹的信息性字段**：它记录这笔改动发生在什么逻辑时刻，
   * 写进 history 和 `meta.updated`，不参与任何判断。调试模式下日期可以被任意回拨，
   * 所以它可能不单调——这是正确的，它是一个逻辑时钟，不是墙上时钟。
   */

  const next: PlanFile = clonePlan(plan);
  const summary = execute(next, cmd);
  if (typeof summary !== 'string') return { ok: false, error: summary.error };

  const issues = validatePlan(next);
  const hard = issues.filter((i) => i.level === 'error');
  if (hard.length) {
    return { ok: false, error: `校验失败：${hard.map((i) => `${i.path} ${i.message}`).join('；')}` };
  }

  next.version = plan.version + 1;
  next.meta.updated = cmd.at;
  next.history = [...next.history, { at: cmd.at, cmd: cmd.type, summary } satisfies HistoryEntry];

  return { ok: true, plan: next, warnings: issues.filter((i) => i.level === 'warn').map((i) => i.message) };
}

/**
 * 把一个字段补丁应用到一条任务上。
 *
 * `task.edit` 和 `plan.applyAdjustments` 的 `taskPatch` **共用这一份**。
 * 两处各写一遍的话，总有一天会出现「编辑页改得进去、复盘卡片改不进去」
 * （或者反过来），而且那种分歧不会报错。
 *
 * 【这里原来只有一句 `Object.assign(t, cmd.patch)`】——那是个洞。
 * `applyCommand` 之后只跑 `validatePlan`，而那个函数**不管字段的合法性**
 * （它管引用完整性、环、周预算、档期冲突）。于是 `patch: { title: '' }`
 * 会 `ok: true` 地写进计划、写进磁盘，而**下一次启动解析这份文件就失败**，
 * 界面变成「设备上的计划文件无法解析」并进入暂停写入的保护状态。
 *
 * 用整条 `Task.safeParse` 而不是逐字段 if：一次覆盖全部字段（空标题、负时长、
 * 非法日期、超长备注），而且以后给 schema 加约束时这里自动跟着收紧。
 */
function applyTaskPatch(
  next: PlanFile,
  taskId: string,
  patch: TaskEditPatch
): string | { error: string } {
  const t = next.tasks.find((x) => x.id === taskId);
  if (!t) return { error: `未找到任务 ${taskId}` };
  const parsed = Task.safeParse({ ...t, ...patch });
  if (!parsed.success) {
    return { error: `修改不合法：${parsed.error.issues[0]?.message ?? '未知'}` };
  }
  Object.assign(t, parsed.data);
  return `任务「${t.title}」已修改`;
}

/** 就地修改 next，成功返回摘要字符串，失败返回 { error } */
function execute(next: PlanFile, cmd: Command): string | { error: string } {
  const find = (id: string) => next.tasks.find((x) => x.id === id) ?? null;

  switch (cmd.type) {
    case 'task.setStatus': {
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      if (cmd.status === 'done') {
        // 依赖未完成不允许标记完成——保证计划不会「虚假推进」
        const unmet = t.dependsOn.filter((d) => find(d)?.status !== 'done');
        if (unmet.length) return { error: `前置任务未完成：${unmet.join(', ')}` };
      }
      t.status = cmd.status;
      if (cmd.actualMin !== undefined) t.actualMin = cmd.actualMin;
      if (cmd.difficulty !== undefined) t.difficulty = cmd.difficulty;
      return `任务「${t.title}」→ ${cmd.status}`;
    }

    case 'task.setEstimate': {
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      if (cmd.estimateMin <= 0) return { error: '预估时长必须为正' };
      t.estimateMin = cmd.estimateMin;
      return `任务「${t.title}」预估改为 ${cmd.estimateMin} 分钟`;
    }

    case 'task.reschedule': {
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      t.scheduledFor = cmd.scheduledFor;
      // 手动改期默认上锁：尊重学生的主动决策，引擎不再自动挪它。
      // 显式传 pin:false 可以只要改期不要上锁。
      t.pinned = cmd.pin ?? true;
      const lock = t.pinned ? '（已上锁，引擎不会自动改动）' : '';
      return cmd.scheduledFor
        ? `任务「${t.title}」改到 ${cmd.scheduledFor}${lock}`
        : `任务「${t.title}」移回待排池${lock}`;
    }

    case 'task.setPinned': {
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      t.pinned = cmd.pinned;
      return `任务「${t.title}」${cmd.pinned ? '已上锁' : '已解锁'}`;
    }

    case 'task.setNotBefore': {
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      t.notBefore = cmd.notBefore;
      return cmd.notBefore
        ? `任务「${t.title}」最早可安排到 ${cmd.notBefore}`
        : `任务「${t.title}」取消最早可安排日限制`;
    }

    case 'task.edit': {
      const r = applyTaskPatch(next, cmd.taskId, cmd.patch);
      if (typeof r !== 'string') return r;
      return r;
    }

    case 'task.add': {
      if (find(cmd.task.id)) return { error: `任务 id 已存在：${cmd.task.id}` };
      const parsed = Task.safeParse(cmd.task);
      if (!parsed.success) return { error: `任务数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
      next.tasks = [...next.tasks, parsed.data];
      return `新增任务「${parsed.data.title}」`;
    }

    case 'task.remove': {
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      // 被删任务的依赖也要清理，否则留下悬空引用
      for (const other of next.tasks) other.dependsOn = other.dependsOn.filter((d) => d !== cmd.taskId);
      next.tasks = next.tasks.filter((x) => x.id !== cmd.taskId);
      return `删除任务「${t.title}」`;
    }

    case 'goal.update': {
      Object.assign(next.goal, cmd.patch);
      return `更新目标：${cmd.patch.statement ?? '（字段变更）'}`;
    }

    case 'constraints.update': {
      Object.assign(next.constraints, cmd.patch);
      return '更新时间约束';
    }

    case 'competence.update': {
      const c = next.competences.find((x) => x.id === cmd.competenceId);
      if (!c) return { error: `未找到能力点 ${cmd.competenceId}` };
      c.current = Math.max(0, Math.min(1, cmd.current));
      if (cmd.evidenceTaskId && !c.evidence.includes(cmd.evidenceTaskId)) {
        c.evidence = [...c.evidence, cmd.evidenceTaskId];
      }
      return `能力点「${c.name}」掌握度 → ${c.current.toFixed(2)}`;
    }

    case 'resource.add': {
      if (next.resources.some((r) => r.id === cmd.resource.id)) return { error: `资源 id 已存在：${cmd.resource.id}` };
      const parsed = Resource.safeParse(cmd.resource);
      if (!parsed.success) return { error: `资源数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
      next.resources = [...next.resources, parsed.data];
      return `新增资源「${parsed.data.title}」`;
    }

    case 'plan.attachResources': {
      const existing = new Set(next.resources.map((r) => r.id));
      const added: string[] = [];
      for (const r of cmd.resources) {
        // 幂等：已经有了就跳过，不报错
        if (existing.has(String(r.id))) continue;
        const parsed = Resource.safeParse(r);
        // 单条不合法只跳过这一条，不整批失败——一条坏数据不该让学生
        // 连另外九条好资料也拿不到
        if (!parsed.success) continue;
        next.resources = [...next.resources, parsed.data];
        existing.add(parsed.data.id);
        added.push(parsed.data.id);
      }

      let touched = 0;
      if (cmd.links.length) {
        next.tasks = next.tasks.map((t) => {
          const link = cmd.links.find((l) => l.taskId === t.id);
          if (!link) return t;
          // 只挂确实存在的资源；引用一个不存在的 id 会让 validatePlan 判错
          const valid = link.resourceIds.filter((id) => existing.has(id));
          const merged = [...new Set([...t.resourceIds, ...valid])];
          if (merged.length === t.resourceIds.length) return t;
          touched++;
          return { ...t, resourceIds: merged };
        });
        // links 里指向不存在任务的条目静默忽略：任务可能在两次检索之间被删掉了
      }

      if (!added.length && touched === 0) return '资料和上次一样，没有变化';
      const bits: string[] = [];
      if (added.length) bits.push(`检索到 ${added.length} 条资料`);
      if (touched) bits.push(`挂到 ${touched} 个任务上`);
      return bits.join('，');
    }

    case 'plan.applyAdjustments': {
      for (const a of cmd.applied) {
        switch (a.kind) {
          case 'reschedule': {
            const t = find(a.taskId);
            if (!t) return { error: `未找到任务 ${a.taskId}` };
            t.scheduledFor = a.scheduledFor;
            break;
          }
          case 'estimate': {
            const t = find(a.taskId);
            if (!t) return { error: `未找到任务 ${a.taskId}` };
            t.estimateMin = a.estimateMin;
            break;
          }
          case 'taskPatch': {
            const r = applyTaskPatch(next, a.taskId, a.patch);
            if (typeof r !== 'string') return r;
            break;
          }
          case 'goal':
            Object.assign(next.goal, a.patch);
            break;
          case 'addTask': {
            if (find(a.task.id)) return { error: `任务 id 已存在：${a.task.id}` };
            const parsed = Task.safeParse(a.task);
            if (!parsed.success) return { error: `任务数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
            next.tasks = [...next.tasks, parsed.data];
            break;
          }
          case 'dropTask':
            for (const o of next.tasks) o.dependsOn = o.dependsOn.filter((d) => d !== a.taskId);
            next.tasks = next.tasks.filter((x) => x.id !== a.taskId);
            break;
          case 'addResource': {
            if (next.resources.some((r) => r.id === a.resource.id)) break;
            const parsed = Resource.safeParse(a.resource);
            if (!parsed.success) return { error: `资源数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
            next.resources = [...next.resources, parsed.data];
            break;
          }
          case 'profile': {
            /**
             * 合并而不是替换：学生说「每周只有 3 小时了」时只带一个字段，
             * 其余的认识（什么水平、哪儿弱）不该被清掉。
             *
             * 这里**不校验字段名**——白名单在 `ProfilePatch` 那边，
             * 而 `plan.profile` 在 schema 里是宽松类型，所以一份对不上的档案
             * 最坏也只是被客户端忽略（`LearnerProfile.safeParse` 失败就当没有），
             * 不会让整份计划读不出来。
             */
            const cur = (next.profile ?? {}) as Record<string, unknown>;
            next.profile = { ...cur, ...a.patch };
            break;
          }
          case 'milestone': {
            const i = next.milestones.findIndex((x) => x.id === a.milestoneId);
            if (i < 0) return { error: `未找到目标 ${a.milestoneId}` };
            const merged = { ...next.milestones[i]!, ...a.patch };
            const parsed = Milestone.safeParse(merged);
            if (!parsed.success) return { error: `目标数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
            next.milestones = next.milestones.map((x, k) => (k === i ? parsed.data : x));
            break;
          }
          case 'addMilestone': {
            /**
             * 顺序是**先定目标、再挂能力点、最后挂任务**——因为后两步都要引用
             * 第一步刚生成的那个 id。整段在一个 case 里跑完，所以外面看到的
             * 仍然是一次原子变更。
             */
            if (next.milestones.some((x) => x.id === a.milestone.id)) {
              return { error: `目标 id 已存在：${a.milestone.id}` };
            }
            const ms = Milestone.safeParse({ ...a.milestone, competenceIds: a.competences.map((c) => c.id) });
            if (!ms.success) return { error: `目标数据非法：${ms.error.issues[0]?.message ?? '未知'}` };

            const comps: typeof next.competences = [];
            for (const c of a.competences) {
              if (next.competences.some((x) => x.id === c.id) || comps.some((x) => x.id === c.id)) {
                return { error: `能力点 id 已存在：${c.id}` };
              }
              const parsed = Competence.safeParse(c);
              if (!parsed.success) return { error: `能力点数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
              comps.push(parsed.data);
            }

            const added: typeof next.tasks = [];
            for (const t of a.tasks) {
              if (next.tasks.some((x) => x.id === t.id) || added.some((x) => x.id === t.id)) {
                return { error: `任务 id 已存在：${t.id}` };
              }
              // 连线在这里强制指向新目标，不看传进来的 milestoneId——
              // 模型给的值一律以代码算出来的为准
              const parsed = Task.safeParse({ ...t, milestoneId: a.milestone.id });
              if (!parsed.success) return { error: `任务数据非法：${parsed.error.issues[0]?.message ?? '未知'}` };
              added.push(parsed.data);
            }

            next.milestones = [...next.milestones, ms.data];
            next.competences = [...next.competences, ...comps];
            next.tasks = [...next.tasks, ...added];
            break;
          }
        }
      }
      if (cmd.review) next.reviews = [...next.reviews, { ...cmd.review, adjustments: cmd.applied.map((a) => a.reason) }];

      /**
       * 摘要要说人话。
       *
       * 「应用了 4 项调整」在通知条上等于没说——学生看不到自己刚做的
       * 「加了一条新的备赛线」这件事发生了什么。新增目标/改目标截止日这两类
       * 是**结构性**变更（不是挪一个日期），所以单独点名，其余合成一句。
       */
      const bits: string[] = [];
      const addedMilestones = cmd.applied.filter((a) => a.kind === 'addMilestone');
      for (const a of addedMilestones) bits.push(`新增目标「${a.milestone.title}」`);
      const movedMilestones = cmd.applied.filter((a) => a.kind === 'milestone').length;
      if (movedMilestones) bits.push(`调整了 ${movedMilestones} 个目标`);
      const others = cmd.applied.length - addedMilestones.length - movedMilestones;
      if (others) bits.push(bits.length ? `另有 ${others} 项调整` : `应用了 ${others} 项调整`);
      return bits.join('，') || '没有需要应用的调整';
    }

    case 'plan.settle': {
      const seen = new Set<string>();
      for (const t of next.tasks) seen.add(t.id);

      // 认不出来的 id 静默跳过：任务可能在结算页打开之后被删掉了。
      // 一条对不上的 id 不该让整次结算失败——学生会丢掉其余全部的勾选
      const doneIds = cmd.done.filter((id) => seen.has(id));
      const skippedIds = cmd.skipped.filter((id) => seen.has(id));
      const pendingIds = cmd.pending.filter((id) => seen.has(id));
      const doneSet = new Set(doneIds);
      const skippedSet = new Set(skippedIds);

      for (const t of next.tasks) {
        // 「放弃」用 skipped 而不是物理删除：删掉会让「学生主动放弃」
        // 和「这项从来没存在过」变成同一件事，而它们在复盘时是完全不同的信息
        if (doneSet.has(t.id)) t.status = 'done';
        else if (skippedSet.has(t.id)) t.status = 'skipped';
      }

      let carried = 0;
      if (cmd.carry !== 'hold') {
        const target = new Map((cmd.reschedule ?? []).map((r) => [r.taskId, r.scheduledFor]));
        for (const id of pendingIds) {
          const t = find(id);
          if (!t) continue;
          // 学生刚在结算页勾了「做完了」或「放弃」的，不再当没做处理
          if (t.status !== 'todo' && t.status !== 'doing' && t.status !== 'blocked') continue;
          t.scheduledFor = cmd.carry === 'compress' ? (target.get(id) ?? null) : null;
          // 过期任务是引擎算出来的，不是学生手排的，所以不上锁
          t.pinned = false;
          carried++;
        }
      }

      const bits: string[] = [];
      if (doneIds.length) bits.push(`${doneIds.length} 项确认完成`);
      if (skippedIds.length) bits.push(`${skippedIds.length} 项放弃`);
      if (carried) bits.push(`${carried} 项${cmd.carry === 'compress' ? '重新排期' : '移回待排池'}`);
      if (cmd.carry === 'hold') bits.push('排期先不动');

      next.reviews = [...next.reviews, { ...cmd.review, adjustments: bits }];
      return `结账 ${cmd.from} ~ ${cmd.to}：${bits.join('，') || '没有变化'}`;
    }

    case 'plan.restore': {
      if (cmd.snapshot.id !== next.id) return { error: '快照与本计划 id 不一致' };
      if (cmd.snapshot.version >= next.version) return { error: '只能回滚到更早的版本' };
      const restored = clonePlan(cmd.snapshot);
      restored.version = next.version + 1; // 回滚本身也是一次前进，历史不可改写
      restored.meta.updated = cmd.at;
      // 历史只增不减：保留回滚前的全部历史，本笔由 applyCommand 统一追加。
      // 这里若自己再追加一次，会与 applyCommand 的追加重复（曾因此写坏过 history）。
      restored.history = next.history;
      Object.assign(next, restored);
      return `回滚到 v${cmd.snapshot.version}`;
    }
  }
}

/** 迁移入口：格式升级时在这里按 schema 版本转换 */
export function migrate(raw: unknown): PlanFile {
  const anyRaw = raw as { schema?: string };
  if (anyRaw?.schema === SCHEMA_ID) return raw as PlanFile;
  throw new Error(`不支持的 schema：${anyRaw?.schema ?? '(缺失)'}`);
}
