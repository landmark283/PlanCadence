/**
 * studyplan/v1 —— 计划文件格式定义（唯一真相源）
 *
 * 设计原则：
 *  1. 这个文件是唯一真相源。前端类型、后端校验、LLM 输出契约、文件读写全部从这里派生。
 *  2. 所有跨实体引用一律用 id，绝不用标题字符串。
 *  3. 状态是语义化枚举，不是 checkbox 符号。
 *  4. schema 字段保留版本演进空间。
 *
 * 注意：这里刻意不使用 zod 版本特有的 API（如 z.iso.datetime()），
 *       全部用 regex，避免 zod 3/4 升级时整体报错。
 */
import { z } from 'zod';

export const SCHEMA_ID = 'studyplan/v1' as const;
export const FILE_EXT = '.studyplan' as const;
/** 计划文件名模板，服务端与移动端共用，避免两处硬编码 */
export const PLAN_FILE_NAME = `plan${FILE_EXT}`;

/* ------------------------------------------------------------------ *
 * 原子类型
 * ------------------------------------------------------------------ */

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'id 必须是小写字母开头、只含小写字母/数字/下划线的短标识');
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');
const TimeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间必须是 HH:mm（24 小时制）');
const StampStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/, '时间戳必须是 ISO 8601');
/** 掌握度 / 难度：0..1 连续量，用小数避免"1-5 星"的粒度歧义 */
const Ratio = z.number().min(0).max(1);
export const PositiveInt = z.number().int().positive();

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

export const TaskStatus = z.enum([
  'todo', // 未开始
  'doing', // 进行中
  'done', // 完成
  'skipped', // 学生主动跳过（区别于 blocked：这是意愿问题）
  'blocked', // 被依赖/外部因素卡住（这是能力或条件问题）
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskType = z.enum([
  'read', // 阅读/看课
  'practice', // 做题/练习
  'project', // 动手做项目
  'review', // 复习（由间隔重复算法插入）
  'assess', // 自测/诊断
]);
export type TaskType = z.infer<typeof TaskType>;

export const Priority = z.enum(['low', 'medium', 'high']);
export const MilestoneStatus = z.enum(['pending', 'active', 'done', 'dropped']);
export const ResourceKind = z.enum(['article', 'video', 'course', 'book', 'problem_set', 'contest', 'tool']);
export type ResourceKind = z.infer<typeof ResourceKind>;

/**
 * 标记的颜色档位。
 *
 * 取值刻意和界面上的 `ChipTone` 完全一致，所以「标记支持自定义颜色」这件事
 * 将来只需要往目录里写一个 tone，不需要另起一套颜色体系。
 * （schema 不认识界面组件，所以这里是它自己的枚举；两边靠取值相同对齐，有测试盯着。）
 */
export const TagTone = z.enum(['neutral', 'accent', 'warning', 'success', 'danger']);
export type TagTone = z.infer<typeof TagTone>;

/* ------------------------------------------------------------------ *
 * 实体
 * ------------------------------------------------------------------ */

export const Meta = z.object({
  title: z.string().min(1).max(120),
  /** 本地时区的展示用时间戳，仅用于 UI，不参与任何判断 */
  created: StampStr,
  /**
   * 最后一次写入的逻辑时刻。
   *
   * **它不参与任何判断，只用于展示和历史回放。** 这句话以前是假的：
   * `applyCommand` 当时拿它当硬性守卫（命令时间早于它就拒绝），
   * 于是必须养一个假时钟来保证时间递增。那条守卫已经删了（见 commands.ts），
   * 现在它才真的是一个纯展示字段。
   *
   * 因此调试模式下把日期往回拨时，**它可能倒退**。这是正确的：
   * 它是逻辑时钟，不是墙上时钟。
   */
  updated: StampStr,
  /** 作者/设备标识，多端合并时用得上，可选 */
  origin: z.string().max(64).optional(),
});
export type Meta = z.infer<typeof Meta>;

export const Goal = z.object({
  /** 一句话目标，学生原话，不要 AI 改写——原话在复盘页有情感价值 */
  statement: z.string().min(1).max(300),
  /** 可验证的成功标准。空数组是合法的，但复盘时系统应提示补充 */
  successCriteria: z.array(z.string().max(200)).max(8).default([]),
  deadline: DateStr.nullable().default(null),
  priority: Priority.default('medium'),
});
export type Goal = z.infer<typeof Goal>;

export const TimeSlot = z.object({
  day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  from: TimeStr,
  to: TimeStr,
});

export const Constraints = z.object({
  weeklyMinutes: PositiveInt,
  availableSlots: z.array(TimeSlot).default([]),
  /** 单次学习时长上限，规则层用它切分长任务 */
  maxSessionMinutes: PositiveInt.default(90),
  /** 不可用日期（考试、假期、出差） */
  blackouts: z
    .array(z.object({ from: DateStr, to: DateStr, reason: z.string().max(120).optional() }))
    .default([]),
});
export type Constraints = z.infer<typeof Constraints>;

/** 能力点——自适应引擎的实际操作对象，任务只是达成它的手段 */
export const Competence = z.object({
  id: Id,
  name: z.string().min(1).max(80),
  /** 目标掌握度 0..1 */
  target: Ratio,
  /** 当前估计掌握度 0..1，由复盘和完成情况更新 */
  current: Ratio,
  /** 支撑该估计的证据（任务 id），保证"为什么认为你掌握了"可回答 */
  evidence: z.array(Id).default([]),
});
export type Competence = z.infer<typeof Competence>;

export const Milestone = z.object({
  id: Id,
  title: z.string().min(1).max(120),
  due: DateStr.nullable().default(null),
  competenceIds: z.array(Id).default([]),
  status: MilestoneStatus.default('pending'),
  /** 达成判据，复盘时逐条勾 */
  criteria: z.array(z.string().max(200)).default([]),
});
export type Milestone = z.infer<typeof Milestone>;

export const Task = z.object({
  id: Id,
  title: z.string().min(1).max(160),
  milestoneId: Id.nullable().default(null),
  /** 前置任务 id：构成 DAG，规则层用它做拓扑排序和阻塞判定 */
  dependsOn: z.array(Id).default([]),
  estimateMin: PositiveInt,
  type: TaskType,
  status: TaskStatus.default('todo'),
  /** 排期日；null 表示"待排"（池子里，未分配到具体某天） */
  scheduledFor: DateStr.nullable().default(null),
  /**
   * 学生手动排定的日期。置 true 后引擎不再自动挪动它。
   *
   * 存在的理由：「协商」是这个产品的核心卖点，而如果系统把学生主动做过的调整
   * 又改回去，学生就会认为「我说了不算」——那比排得不优更伤。手动改期默认上锁，
   * 学生可随时解锁。
   */
  pinned: z.boolean().default(false),
  /**
   * 最早可安排的日期。表达「这门等考完再说」这类意图。
   *
   * 存在的理由来自一次真实事故：示例里 t_graph01 的 notes 写着「等期中考试周之后再安排」，
   * 但引擎读不懂自由文本，把它排到了期中考试周**之前**。
   * 学生说了不算，比排得不优严重得多——而且离线降级时没有 LLM 兜底，
   * 所以这种意图必须能被结构化地表达，并让规则层强制执行。
   */
  notBefore: DateStr.nullable().default(null),
  /** 实际投入分钟数，学生可填，用于校准 estimateMin 的偏差 */
  actualMin: z.number().int().min(0).nullable().default(null),
  /** 学生自评难度 0..1（null = 未评），是掌握度更新的输入之一 */
  difficulty: Ratio.nullable().default(null),
  resourceIds: z.array(Id).default([]),
  /**
   * 学生自己打的标记。
   *
   * **存的是标记 id，不是文字**——这是这个字段唯一的重点，也是它存在的理由。
   * 以后要加「时间标记（影响排期）」或者「标记自定义颜色」，
   * 改的是标记目录（`PlanFile.tags` / `plan/tags.ts`）和引擎，**任务上的数据不用动**。
   *
   * 认不出来的 id 在渲染时静默跳过（和 `resourceIds` 找不到资源同一个处理），
   * **刻意不在 validatePlan 里查**：那样一个过期的标记 id 会让整条命令被拒，
   * 而它顶多让一个胶囊不显示。代价和收益不成比例。
   */
  tags: z.array(Id).default([]),
  notes: z.string().max(2000).default(''),
});
export type Task = z.infer<typeof Task>;
/** 构造用类型：带 default() 的字段在输入侧是可选的，写夹具和命令载荷时用这个 */
export type TaskInput = z.input<typeof Task>;

export const Resource = z.object({
  id: Id,
  title: z.string().min(1).max(200),
  url: z.string().url(),
  kind: ResourceKind,
  /** 抓取/校验时间。演示时展示这个字段，直接证明"信息是实时拿的"而不是模型编的 */
  verifiedAt: StampStr.nullable().default(null),
  /**
   * 来源标识。约定的取值：
   *   · `资料库快照@<日期>` —— 来自内置资料库，人工核对过网址（见 tools/library.ts）
   *   · `<主机名>/api`（如 `codeforces.com/api`）—— 运行时实时抓回来的
   *   · 其他自由文本 —— 演示夹具等
   * 界面上会如实显示，所以**不能拿它写一个不存在的工具名**。
   */
  source: z.string().max(64).optional(),
  /**
   * 截止日期（赛事报名 / 作业提交）。
   *
   * 存在的理由和 `Task.notBefore` 是同一个：示例里赛事卡片原本把截止日写在**标题字符串**里
   * （"校内模拟赛（报名截止 2026-11-15）"），于是倒计时只能靠正则去抠标题——
   * 抠不到就静默没有倒计时，而"还有几天截止"恰恰是这张卡最有价值的信息。
   * 机器要用来判断的事实，不能只活在给人看的文本里。
   */
  deadline: DateStr.nullable().default(null),
});
export type Resource = z.infer<typeof Resource>;
export type ResourceInput = z.input<typeof Resource>;

/**
 * 标记目录里的一条。
 *
 * 内置的四条写在代码里（`plan/tags.ts` 的 `BUILTIN_TAGS`），这里放的是
 * **学生自定义的**——当前版本还没有创建自定义标记的界面，所以它通常是空的。
 * 之所以现在就把它加进格式：任务上引用的是 id，得有个地方让那些 id 有定义；
 * 而且它是 `.default([])`，旧文件照常解析，不需要迁移。
 */
export const Tag = z.object({
  id: Id,
  /** 卡片上那个胶囊里的字。短是硬要求——它要和状态、类型、时长挤在同一行 */
  label: z.string().min(1).max(12),
  tone: TagTone.default('neutral'),
});
export type Tag = z.infer<typeof Tag>;

export const Review = z.object({
  at: StampStr,
  /**
   * 这条记录是什么。
   *
   * 为什么需要：v0.2 起 `plan.settle`（回归结账）也会往 `reviews` 里写一条。
   * 没有这个字段时，「上次复盘是什么时候」会被一次结账污染——
   * 而复盘页要显示「之前的复盘日志」，混进结账记录就是错的。
   * 默认 `'review'`，所以加它之前写下的记录仍然读得进来，`SCHEMA_ID` 不用动。
   */
  kind: z.enum(['review', 'settle']).default('review'),
  /** 本周期应完成 vs 实际完成 */
  plannedTasks: z.number().int().min(0),
  completedTasks: z.number().int().min(0),
  /** 学生自评：整体是太轻松还是太吃力，0.5 = 刚好 */
  loadFeedback: Ratio.nullable().default(null),
  notes: z.string().max(2000).default(''),
  /** 本次复盘产生了哪些调整（人话描述，用于回放） */
  adjustments: z.array(z.string().max(200)).default([]),
  /**
   * 这次复盘（或结账）问过什么、答了什么。
   *
   * 存下来是为了复盘页底部那个「之前的复盘」折叠区——学生回头看
   * 「上个月我说的是时间不够，这个月还是」是有意义的。
   * 存的是**问答对**而不是模型的原话，所以它很小，也不会有隐私问题。
   */
  dialogue: z
    .array(z.object({ prompt: z.string().max(160), answer: z.string().max(300) }))
    .max(8)
    .default([]),
});
export type Review = z.infer<typeof Review>;

/** 历史记录——只追加，不修改。回滚靠 versions/ 快照，不靠重放 */
export const HistoryEntry = z.object({
  at: StampStr,
  cmd: z.string().min(1).max(48),
  summary: z.string().max(300),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

/* ------------------------------------------------------------------ *
 * 顶层文件
 * ------------------------------------------------------------------ */

export const PlanFile = z.object({
  schema: z.literal(SCHEMA_ID),
  id: Id,
  /** 单调递增，每次 applyCommand 成功后 +1 */
  version: z.number().int().positive(),
  meta: Meta,
  goal: Goal,
  constraints: Constraints,
  /**
   * 学生档案：几年级、什么水平、每周有多少时间、哪儿弱。
   *
   * ## 为什么放进计划文件（而不是像设置那样留在设备上）
   *
   * 这份东西是**关于这个学生的**，不是关于这台设备的。放进计划文件之后：
   *   · 重开 App 它还在（之前只在内存里，重启就忘了）；
   *   · 换设备、把文件发给同学，上下文跟着走——对方看到的不再是一份
   *     「只有日期没有来由」的任务表；
   *   · 「跟 AI 说说」和找资料都有依据，不必每次都从计划内容反推。
   *
   * 类型上是 `unknown` 的宽松校验：`LearnerProfile` 住在 `llm/interview.ts`，
   * 而 schema 层不该反向依赖 llm 层。真正的校验在 `parsePlan` 之后的
   * `LearnerProfile.safeParse`（见 `plan/profile.ts`），校验不过就当没有，
   * **不让一份坏档案把整份计划卡住**。
   */
  profile: z.unknown().nullable().default(null),
  competences: z.array(Competence).default([]),
  milestones: z.array(Milestone).default([]),
  tasks: z.array(Task).default([]),
  resources: z.array(Resource).default([]),
  /** 标记目录（学生自定义的那部分）。内置的在代码里，见 plan/tags.ts */
  tags: z.array(Tag).default([]),
  reviews: z.array(Review).default([]),
  history: z.array(HistoryEntry).default([]),
});
export type PlanFile = z.infer<typeof PlanFile>;

/* ------------------------------------------------------------------ *
 * 语义校验——这些是 schema 表达不了、但格式必须保证的不变量
 * ------------------------------------------------------------------ */

export type PlanIssue = { level: 'error' | 'warn'; path: string; message: string };

export function validatePlan(plan: PlanFile): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const ids = (xs: { id: string }[]) => new Set(xs.map((x) => x.id));

  const taskIds = ids(plan.tasks);
  const msIds = ids(plan.milestones);
  const compIds = ids(plan.competences);
  const resIds = ids(plan.resources);

  // 1) 全局 id 唯一
  const all = [...plan.tasks, ...plan.milestones, ...plan.competences, ...plan.resources].map((x) => x.id);
  const dup = all.filter((v, i) => all.indexOf(v) !== i);
  for (const d of new Set(dup)) issues.push({ level: 'error', path: `id:${d}`, message: 'id 重复' });

  // 2) 引用完整性
  for (const t of plan.tasks) {
    if (t.milestoneId && !msIds.has(t.milestoneId))
      issues.push({ level: 'error', path: `task:${t.id}.milestoneId`, message: `未找到里程碑 ${t.milestoneId}` });
    for (const d of t.dependsOn)
      if (!taskIds.has(d))
        issues.push({ level: 'error', path: `task:${t.id}.dependsOn`, message: `未找到前置任务 ${d}` });
    for (const r of t.resourceIds)
      if (!resIds.has(r))
        issues.push({ level: 'error', path: `task:${t.id}.resourceIds`, message: `未找到资源 ${r}` });
  }
  for (const m of plan.milestones)
    for (const c of m.competenceIds)
      if (!compIds.has(c))
        issues.push({ level: 'error', path: `milestone:${m.id}.competenceIds`, message: `未找到能力点 ${c}` });

  // 3) dependsOn 无环（DFS 三色标记）
  const graph = new Map(plan.tasks.map((t) => [t.id, t.dependsOn]));
  const color = new Map<string, 0 | 1 | 2>();
  const cycle: string[] = [];
  const visit = (n: string): boolean => {
    const c = color.get(n) ?? 0;
    if (c === 1) {
      cycle.push(n);
      return true;
    }
    if (c === 2) return false;
    color.set(n, 1);
    for (const m of graph.get(n) ?? []) if (visit(m)) {
      cycle.push(n);
      return true;
    }
    color.set(n, 2);
    return false;
  };
  for (const t of plan.tasks) if (visit(t.id)) break;
  if (cycle.length)
    issues.push({ level: 'error', path: 'tasks', message: `dependsOn 存在环：${cycle.reverse().join(' -> ')}` });

  // 4) 时间预算（warn 而非 error——允许超载，但必须让人知道）
  const byWeek = new Map<string, number>();
  for (const t of plan.tasks) {
    if (!t.scheduledFor || t.status === 'done' || t.status === 'skipped') continue;
    const week = isoWeekKey(t.scheduledFor);
    byWeek.set(week, (byWeek.get(week) ?? 0) + t.estimateMin);
  }
  for (const [week, min] of byWeek)
    if (min > plan.constraints.weeklyMinutes)
      issues.push({
        level: 'warn',
        path: `week:${week}`,
        message: `排期 ${min} 分钟，超出周预算 ${plan.constraints.weeklyMinutes} 分钟`,
      });

  // 5) 排期落在 blackout 内
  for (const t of plan.tasks) {
    if (!t.scheduledFor) continue;
    for (const b of plan.constraints.blackouts)
      if (t.scheduledFor >= b.from && t.scheduledFor <= b.to)
        issues.push({ level: 'warn', path: `task:${t.id}`, message: `排期落在不可用区间 ${b.from}~${b.to}` });
  }

  // 5b) 排期早于学生指定的「最早可安排日」——这是学生明说过的意愿，违反它必须报出来
  for (const t of plan.tasks) {
    if (t.scheduledFor && t.notBefore && t.scheduledFor < t.notBefore)
      issues.push({
        level: 'warn',
        path: `task:${t.id}`,
        message: `排期 ${t.scheduledFor} 早于最早可安排日 ${t.notBefore}`,
      });
  }

  // 6) 依赖顺序：前置任务不应排在后置之后
  for (const t of plan.tasks) {
    if (!t.scheduledFor) continue;
    for (const d of t.dependsOn) {
      const dep = plan.tasks.find((x) => x.id === d);
      if (dep?.scheduledFor && dep.scheduledFor > t.scheduledFor)
        issues.push({ level: 'warn', path: `task:${t.id}`, message: `排在前置任务 ${d} 之前` });
    }
  }

  // 7) 【曾经这里有一条】「赛事缺少截止日期」的 warn。
  //
  //    删掉了，理由值得写下来免得有人再加回去：
  //
  //    工具调用（§8）上线之后，**没有截止日期的赛事变成了正常状态**——
  //    蓝桥杯 / CCPC / ICPC 只有官网没有可靠日期，我们拒绝编一个，
  //    所以它们天生 `deadline: null`；演示时钟下实时抓来的场次同理。
  //    于是每份生成的计划都会带 3–7 条**一模一样**的警告，全是关于
  //    「我们有意不做的事」。它不是计划里的自相矛盾，塞进「提醒」里只会
  //    把真正需要注意的事淹掉。
  //
  //    这件事的信息该待的地方是**资源卡**：没有截止日的赛事卡会写
  //    「未记录截止日 · 以官网为准」，学生在那儿正好能看到。
  //
  //    顺带一提，那几条重复警告还炸出过一个 React 报错
  //    （`Encountered two children with the same key`），因为复盘页当时
  //    拿警告**文本**当 key。键不能建立在"消息文案不重复"这种假设上。

  // 8) 任务排在目标截止日之后——计划和目标自相矛盾，必须说出来。
  //
  //    真实触发场景：学生每周只有一个晚上、中间还有一整周考试周，
  //    容量不够时引擎会把任务一路顺延，顺延到截止日之后就没人提醒了。
  //    「排得不优」可以忍，「计划本身完不成」不能不说。
  if (plan.goal.deadline) {
    for (const t of plan.tasks) {
      if (t.scheduledFor && t.scheduledFor > plan.goal.deadline)
        issues.push({
          level: 'warn',
          path: `task:${t.id}`,
          message: `排期 ${t.scheduledFor} 晚于目标截止日 ${plan.goal.deadline}`,
        });
    }
  }

  return issues;
}

/** ISO 周键，如 '2026-W14'。周一为一周之始。 */
export function isoWeekKey(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // 周一 = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // 移到本周周四
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * 深拷贝计划对象。
 *
 * 刻意不用 structuredClone：它在 Hermes（React Native 的 JS 引擎）上并非稳定可用，
 * 而本格式是纯 JSON 数据（无 Date / Map / Set / 循环引用），JSON 往返即为正确实现，
 * 同时不依赖 @types/node 或 DOM lib。任务量级只有几十条，性能无关紧要。
 */
export function clonePlan<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 空计划工厂——onboarding 完成前使用 */
export function emptyPlan(id: string, now: string, title: string): PlanFile {
  return PlanFile.parse({
    schema: SCHEMA_ID,
    id,
    version: 1,
    meta: { title, created: now, updated: now },
    goal: { statement: '（待填写）', successCriteria: [], deadline: null, priority: 'medium' },
    constraints: { weeklyMinutes: 300, availableSlots: [], maxSessionMinutes: 90, blackouts: [] },
  });
}
