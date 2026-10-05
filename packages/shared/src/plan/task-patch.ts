/**
 * 任务草稿与字段差分。
 *
 * ## 为什么单独一个模块
 *
 * 「哪些字段真的变了」必须**只有一处实现**。现在用它的是编辑页，
 * 而 B 阶段那个「跟 AI 说说」的协商页也要发同一批 patch——两处各写一遍 diff，
 * 迟早会出现「AI 能改但我改不了」或者「界面说改了、实际没变」。
 *
 * 它同时是纯函数，所以能在 shared 里被测；写在组件里的 diff 测不到。
 *
 * ## 「改期默认上锁」这条规则为什么落在这里
 *
 * `task.reschedule` 从 v0.1 起就有一条规则：**手动改期默认把任务上锁**
 * （理由见 `docs/技术方案.md`：系统把学生主动做过的调整又改回去，
 * 学生会认为「我说了不算」——那比排得不优更伤）。
 *
 * 编辑页改日期走的是 `task.edit`，而 `task.edit` 只是**照 patch 执行**，
 * 它不该替学生猜默认值。所以默认值在这里：`withScheduledFor` 改日期时顺手置
 * `pinned: true`，界面上那个「上锁」胶囊会立刻亮起来，学生想解锁再点一下就行。
 * 命令层保持「你说什么就是什么」，界面侧的决策留在界面侧的纯函数里——而且可测。
 */
import type { Task, TaskType } from './schema.ts';

/**
 * 一条任务里**学生可以直接编辑的字段**。
 *
 * 刻意不含 `status` / `actualMin` / `difficulty`：
 *   · 这三个是勾选框的业务（`task.setStatus`），而 `task-card.tsx` 的文件头
 *     已经写下「完成只走勾选框，避免两个入口改同一个字段」；
 *   · `task.setStatus` 还额外挡着「前置任务未完成不许标完成」，
 *     把它复制进 `task.edit` 就是同一件事的第二个实现。
 * 也不含 `id`（改了就不是同一条任务了）和 `milestoneId`（还没有界面）。
 */
export type TaskDraft = {
  title: string;
  notes: string;
  type: TaskType;
  tags: string[];
  estimateMin: number;
  scheduledFor: string | null;
  pinned: boolean;
  notBefore: string | null;
  dependsOn: string[];
  resourceIds: string[];
};

/**
 * 编辑页发出去的那一份 patch。
 *
 * 命令层（`commands.ts` 的 `task.edit`）**直接用这个类型**，不另写一份：
 * 两边各写一份的话，加一个可编辑字段就得记得改两个地方，而漏掉的那个不会报错——
 * 只会表现为「界面上改了、保存后没变」。
 */
export type TaskEditPatch = Partial<Pick<Task, keyof TaskDraft>>;

/** 从计划里的一条任务取出一份可编辑草稿。数组要拷，否则改草稿会写进原计划 */
export function draftOf(task: Task): TaskDraft {
  return {
    title: task.title,
    notes: task.notes,
    type: task.type,
    tags: [...task.tags],
    estimateMin: task.estimateMin,
    scheduledFor: task.scheduledFor,
    pinned: task.pinned,
    notBefore: task.notBefore,
    dependsOn: [...task.dependsOn],
    resourceIds: [...task.resourceIds],
  };
}

/** 一组 id 是否等价。顺序不算变化——重排 id 不是学生的动作，界面也不提供 */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((x) => set.has(x));
}

/**
 * 草稿相对原任务改了什么。**没有变化返回 `null`**。
 *
 * 返回 null 而不是空对象：调用方要用它决定「保存」按钮能不能点，
 * 而一个空 patch 发出去会**白白产生一次写盘和一条历史**，显示成
 * 「任务「xx」已修改」而其实什么都没改。
 */
export function taskPatch(before: Task, draft: TaskDraft): TaskEditPatch | null {
  const patch: TaskEditPatch = {};

  // 标题去掉首尾空白之后再比：只有空格差别不该算一次修改
  const title = draft.title.trim();
  if (title !== before.title) patch.title = title;
  if (draft.notes !== before.notes) patch.notes = draft.notes;
  if (draft.type !== before.type) patch.type = draft.type;
  if (!sameSet(draft.tags, before.tags)) patch.tags = [...draft.tags];
  if (draft.estimateMin !== before.estimateMin) patch.estimateMin = draft.estimateMin;
  if (draft.scheduledFor !== before.scheduledFor) patch.scheduledFor = draft.scheduledFor;
  if (draft.pinned !== before.pinned) patch.pinned = draft.pinned;
  if (draft.notBefore !== before.notBefore) patch.notBefore = draft.notBefore;
  if (!sameSet(draft.dependsOn, before.dependsOn)) patch.dependsOn = [...draft.dependsOn];
  if (!sameSet(draft.resourceIds, before.resourceIds)) patch.resourceIds = [...draft.resourceIds];

  return Object.keys(patch).length ? patch : null;
}

/**
 * 改日期。**顺手把任务上锁**（理由见文件头）。
 *
 * 日期没变就原样返回，不置 pinned——否则「打开编辑页、什么都没点、点保存」
 * 会给任务上锁，而学生什么也没做。
 */
export function withScheduledFor(draft: TaskDraft, day: string | null): TaskDraft {
  if (day === draft.scheduledFor) return draft;
  return { ...draft, scheduledFor: day, pinned: true };
}

/** 新任务的默认草稿。时长给 45 是最大的档位以外的中点，学生几乎总要改，先给个不荒谬的数 */
export function blankDraft(scheduledFor: string | null): TaskDraft {
  return {
    title: '',
    notes: '',
    type: 'read',
    tags: [],
    estimateMin: 45,
    scheduledFor,
    pinned: scheduledFor !== null,
    notBefore: null,
    dependsOn: [],
    resourceIds: [],
  };
}

/* ------------------------------------------------------------------ *
 * 时长的可调范围
 * ------------------------------------------------------------------ *
 * 编辑页给了一排档位胶囊，但档位之外的分钟数也得能设（学生做完发现
 * 「其实是 40 分钟」）。为了不引入自由文本输入，那里用的是 ± 微调，
 * 于是需要一组上下限和步长。
 *
 * 放在这里而不是组件里：schema 的 `estimateMin` 是 `PositiveInt`（没有上限），
 * 所以这几个数**纯粹是界面约束**，和「什么算合法」是两件事。
 * 写在一起是为了让读的人一眼看到边界在哪。
 */
export const ESTIMATE_STEP = 15;
export const MIN_ESTIMATE_MIN = 5;
/**
 * 单次上限。计划里的 `maxSessionMinutes` 默认 90，但那是「一次坐下来能做多久」，
 * 一条任务可以横跨多次。600 分钟（10 小时）已经远超任何合理的一条任务，
 * 再往上几乎必然是手滑。
 */
export const MAX_ESTIMATE_MIN = 600;
