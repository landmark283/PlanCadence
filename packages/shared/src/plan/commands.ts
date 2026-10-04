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
import { Task, Resource, validatePlan, clonePlan, SCHEMA_ID } from './schema.ts';
import type { PlanFile, TaskStatus, TaskInput, ResourceInput, HistoryEntry } from './schema.ts';

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
  | {
      type: 'task.edit';
      at: string;
      taskId: string;
      patch: Partial<Pick<PlanFile['tasks'][number], 'title' | 'notes' | 'type' | 'dependsOn' | 'resourceIds' | 'notBefore'>>;
    }
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
  /** 回滚：从快照恢复，调用方负责提供目标版本的完整计划 */
  | { type: 'plan.restore'; at: string; snapshot: PlanFile };

/** 协商页里被学生接受的单条调整 */
export type AppliedAdjustment =
  | { kind: 'reschedule'; taskId: string; scheduledFor: string | null; reason: string }
  | { kind: 'estimate'; taskId: string; estimateMin: number; reason: string }
  | { kind: 'goal'; patch: Partial<PlanFile['goal']>; reason: string }
  | { kind: 'addTask'; task: TaskInput; reason: string }
  | { kind: 'dropTask'; taskId: string; reason: string }
  | { kind: 'addResource'; resource: ResourceInput; reason: string };

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
  if (cmd.at < plan.meta.updated) {
    // 防止乱序写入把 version 推回去。多端场景下必须挡住。
    return { ok: false, error: `命令时间 ${cmd.at} 早于计划更新时间 ${plan.meta.updated}` };
  }

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
      const t = find(cmd.taskId);
      if (!t) return { error: `未找到任务 ${cmd.taskId}` };
      Object.assign(t, cmd.patch);
      return `任务「${t.title}」已修改`;
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
        }
      }
      if (cmd.review) next.reviews = [...next.reviews, { ...cmd.review, adjustments: cmd.applied.map((a) => a.reason) }];
      return `应用了 ${cmd.applied.length} 项调整`;
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
