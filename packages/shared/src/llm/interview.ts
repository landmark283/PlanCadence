/**
 * interview：把「了解学生」这件事，做成**结构化表单**而不是聊天框。
 *
 * ## 为什么不是聊天
 *
 * 聊天框看起来更"AI"，但代价很大：
 *   · 学生要打字，信息密度低，还容易答非所问
 *   · 回答是自由文本，进不了 `LearnerProfile`，后面排期时又得再猜一遍
 *   · 做不出漂亮的界面——而"漂亮"是本次参赛的硬要求之一
 *
 * 所以 LLM 只输出**题目规格**（`QuestionSpec`），前端把它渲染成表单控件。
 * 每一题的作答天然是结构化数据，直接进档案。
 *
 * ## 和 advisor 同一条边界
 *
 * 这里同样有本地题库 `QUESTION_BANK`：没有 Key、断网、模型输出不合格时，
 * 访谈必须仍然走得下去。**降级不是"功能消失"，只是"题目不再因人而异"。**
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * 原子
 * ------------------------------------------------------------------ */

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');
const ShortId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'id 必须是小写字母开头');
/** 校验学生在日期输入框里手打的字符串。非结构化输入一律当没答 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ *
 * 题目规格 —— LLM 的输出契约
 * ------------------------------------------------------------------ */

export const QuestionKind = z.enum([
  'single', // 单选
  'multi', // 多选
  'scale', // 从 min 到 max 取一个数（步长 step）
  'date', // 某个日期
  /**
   * 一段日期区间（起 ~ 止）。
   *
   * 存在的理由：「期中考试周」这类不可用时间必须**结构化**。
   * 最初它是一道自由文本题，模型读得懂，但本地兜底读不懂——
   * 于是断网时系统又会把任务排进考试周，正是之前记录过的那类事故。
   * 学生说过的约束，必须能被规则层强制执行，不能只有模型看得懂。
   */
  'dateRange',
  'text', // 一句话
]);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionOption = z.object({
  value: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
});

/**
 * 这道题的答案要写进档案的哪个字段。
 *
 * 存在的理由是一次实测事故：最初没有这个字段，`applyAnswer` 靠**题目 id 猜**——
 * 只认 `q_goal` / `q_weekdays` 这些我们自己定的 id。于是：
 *   · 模型出的题 id 是 `q_dp_focus` 之类，答案**一条都写不进档案**，访谈白做；
 *   · 模型若碰巧用了 `q_weekdays` 这个 id、但选项值是「工作日」，
 *     就写进一个非法的 weekday，档案随即非法，**之后每个请求都 400**。
 *
 * 「靠 id 巧合」是把两个独立的东西绑在一起。现在改成显式声明，
 * 并且写入时按目标字段的 schema 校验（见 `applyAnswer`）。
 * 为 null 表示这题只是收集信息，不落档案。
 */
export const ProfileField = z.enum([
  'goalStatement',
  'deadline',
  'level',
  'weeklyHours',
  'weekdays',
  'weakSpots',
  'blackouts',
]);
export type ProfileField = z.infer<typeof ProfileField>;

export const QuestionSpec = z.object({
  id: ShortId,
  field: ProfileField.nullable().default(null),
  kind: QuestionKind,
  prompt: z.string().min(1).max(160),
  /**
   * 「为什么问这个」。**必填**——这是产品思考最容易被评委看见的地方：
   * 它表明每一题都是为了某个排期决策，不是在凑问题。
   */
  why: z.string().min(1).max(200),
  /** single / multi 用 */
  options: z.array(QuestionOption).max(8).default([]),
  /** scale 用 */
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  step: z.number().positive().nullable().default(null),
  unit: z.string().max(16).nullable().default(null),
  /** text / date 用 */
  placeholder: z.string().max(120).nullable().default(null),
  /**
   * text 题的备选短句。点一下就填进输入框。
   *
   * 存在的理由是演示：现场让评委等学生打 30 个字是浪费的 30 秒，
   * 而"系统给了几个说法供你挑"本身也降低了学生的表达门槛。
   */
  suggestions: z.array(z.string().min(1).max(120)).max(4).default([]),
});
export type QuestionSpec = z.infer<typeof QuestionSpec>;

/* ------------------------------------------------------------------ *
 * 作答
 * ------------------------------------------------------------------ */

export type Answer =
  | { questionId: string; kind: 'single'; value: string }
  | { questionId: string; kind: 'multi'; values: string[] }
  | { questionId: string; kind: 'scale'; value: number }
  | { questionId: string; kind: 'date'; value: string | null }
  | { questionId: string; kind: 'dateRange'; from: string; to: string; reason: string | null }
  | { questionId: string; kind: 'text'; value: string };

/** 学生档案——访谈的产物，也是 `planner.draft` 的输入 */
export const Weekday = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export type Weekday = z.infer<typeof Weekday>;

/** 不可用区间。形状与 `Constraints.blackouts` 保持一致，装配时可直接搬运 */
export const BlackoutRange = z.object({
  from: DateStr,
  to: DateStr,
  reason: z.string().max(120).optional(),
});
export type BlackoutRange = z.infer<typeof BlackoutRange>;

export const LearnerProfile = z.object({
  goalStatement: z.string().max(300).nullable().default(null),
  deadline: DateStr.nullable().default(null),
  level: z.enum(['beginner', 'basic', 'intermediate', 'advanced']).nullable().default(null),
  weeklyHours: z.number().min(0).max(40).nullable().default(null),
  weekdays: z.array(Weekday).max(7).default([]),
  weakSpots: z.array(z.string().max(60)).max(8).default([]),
  /** 整段不能学习的时间（考试周等）。结构化，规则层会强制执行 */
  blackouts: z.array(BlackoutRange).max(6).default([]),
});
export type LearnerProfile = z.infer<typeof LearnerProfile>;

export const emptyProfile = (): LearnerProfile => LearnerProfile.parse({});

type Level = NonNullable<LearnerProfile['level']>;
const LEVELS: Level[] = ['beginner', 'basic', 'intermediate', 'advanced'];
const WEEKDAY_VALUES: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** 每个档案字段只接受哪些题型。kind 与 field 不匹配的题，答案根本写不进去 */
const FIELD_KINDS: Record<ProfileField, QuestionKind[]> = {
  goalStatement: ['text'],
  deadline: ['date'],
  level: ['single'],
  weeklyHours: ['scale'],
  weekdays: ['multi'],
  weakSpots: ['multi'],
  blackouts: ['dateRange'],
};

/**
 * 写档案的唯一入口。
 *
 * 刻意**不直接赋值**，而是先按 `LearnerProfile` 的 schema 校验一遍，
 * 越界或类型不对的值整条丢弃。
 *
 * 为什么这么谨慎：档案一旦非法，之后**每一个** `/interview/next` 请求
 * 都会因为 `profile` 过不了 zod 而返回 400——访谈当场死掉，
 * 而且报错里看不到是哪一题写坏的。宁可少一条信息，也不能让档案变成非法值。
 */
function commit(profile: LearnerProfile, patch: Partial<LearnerProfile>): LearnerProfile {
  const r = LearnerProfile.safeParse({ ...profile, ...patch });
  return r.success ? r.data : profile;
}

/* ------------------------------------------------------------------ *
 * 本地题库 —— 确定性兜底
 * ------------------------------------------------------------------ */

/**
 * 七道题，覆盖排期真正需要的每一个输入。
 *
 * 顺序是有讲究的：先问「你要去哪」（目标、截止日），再问「你现在在哪」（水平），
 * 最后才问「你有多少时间」。反过来问，学生会觉得系统只在关心排班表。
 */
export const QUESTION_BANK: QuestionSpec[] = [
  {
    id: 'q_goal',
    field: 'goalStatement',
    kind: 'text',
    prompt: '你想达成什么？用你自己的话说',
    why: '计划是围绕目标倒推的。保留你的原话而不是改写过的版本，是因为三个月后你还会回来看这句话。',
    placeholder: '例如：明年四月能独立做出省赛中等难度的题',
    suggestions: [
      '明年四月能独立做出省赛中等难度的题',
      '把动态规划从「看到就想跳过」练到能独立写出',
      '先跟上学校的数据结构课，别挂科',
    ],
    options: [],
    min: null,
    max: null,
    step: null,
    unit: null,
  },
  {
    id: 'q_deadline',
    field: 'deadline',
    kind: 'date',
    prompt: '有没有一个必须赶上的时间点？',
    why: '有截止日才能倒着排：现在是几月，每周至少要推进多少。没有截止日的计划通常会一直停在第一周。',
    placeholder: '2027-04-11',
    suggestions: [],
    options: [],
    min: null,
    max: null,
    step: null,
    unit: null,
  },
  {
    id: 'q_level',
    field: 'level',
    kind: 'single',
    prompt: '你现在大概在什么位置？',
    why: '起点决定第一周是先补概念还是直接做题。定得太高，第一周就会被劝退。',
    options: [
      { value: 'beginner', label: '基本没接触过' },
      { value: 'basic', label: '学过语法，没做过题' },
      { value: 'intermediate', label: '能做出简单题，中等题吃力' },
      { value: 'advanced', label: '中等题稳定，想冲难题' },
    ],
    min: null,
    max: null,
    step: null,
    unit: null,
    placeholder: null,
    suggestions: [],
  },
  {
    id: 'q_weekly',
    field: 'weeklyHours',
    kind: 'scale',
    prompt: '每周大概能投入多少小时？',
    why: '排期必须落在你真的有的时间里。按「理想情况」排出来的计划，第一天就作废了。',
    options: [],
    min: 3,
    max: 15,
    step: 2,
    unit: '小时 / 周',
    placeholder: null,
    suggestions: [],
  },
  {
    id: 'q_weekdays',
    field: 'weekdays',
    kind: 'multi',
    prompt: '哪几天比较方便？',
    why: '离散的时段比「每周 10 小时」有用得多——后者排不出「周三晚上做什么」。',
    options: [
      { value: 'mon', label: '周一' },
      { value: 'tue', label: '周二' },
      { value: 'wed', label: '周三' },
      { value: 'thu', label: '周四' },
      { value: 'fri', label: '周五' },
      { value: 'sat', label: '周六' },
      { value: 'sun', label: '周日' },
    ],
    min: null,
    max: null,
    step: null,
    unit: null,
    placeholder: null,
    suggestions: [],
  },
  {
    id: 'q_weak',
    field: 'weakSpots',
    kind: 'multi',
    prompt: '觉得自己最容易被卡住的是哪一块？',
    why: '先补最容易让你放弃的那块，比平均用力更能坚持下来。',
    // 必须给选项：多选题没有选项就是一个渲染不出东西的空壳控件。
    // 宁可让学生从固定几项里挑，也不要给一个只能干瞪眼的框。
    options: [
      { value: '动态规划', label: '动态规划' },
      { value: '图论', label: '图论' },
      { value: '数学推导', label: '数学推导' },
      { value: '读题慢', label: '读题慢' },
      { value: '不知道从哪下手', label: '写代码时不知道从哪下手' },
    ],
    min: null,
    max: null,
    step: null,
    unit: null,
    placeholder: null,
    suggestions: [],
  },
  {
    id: 'q_blackout',
    field: 'blackouts',
    kind: 'dateRange',
    prompt: '有没有整段不能学习的时间？',
    why: '期中考试周这类区间必须提前避开。上一版计划就是把它排到了考试周之前——你说了不算，比排得不优严重得多。',
    placeholder: '2026-11-02',
    suggestions: [],
    options: [],
    min: null,
    max: null,
    step: null,
    unit: null,
  },
];

/** 访谈最多几题。约束来自 §7.1：超过 8 题学生就开始乱答了 */
export const MAX_QUESTIONS = 8;

/**
 * 取下一题。
 *
 * 本地版本只按题库顺序走——它不"因人而异"，但保证访谈永远走得完。
 * 模型不可用时走这条；可用时由服务端 `interview.nextTurn` 出题。
 */
export function nextLocalQuestion(asked: QuestionSpec[]): QuestionSpec | null {
  const seen = new Set(asked.map((q) => q.id));
  if (asked.length >= MAX_QUESTIONS) return null;
  return QUESTION_BANK.find((q) => !seen.has(q.id)) ?? null;
}

/* ------------------------------------------------------------------ *
 * 作答 → 档案
 * ------------------------------------------------------------------ */

/** 把一道题的作答写进档案。纯函数，可回放，可自测 */
export function applyAnswer(profile: LearnerProfile, q: QuestionSpec, a: Answer): LearnerProfile {
  // id 对不上说明这条作答不是这题的；field 为 null 说明这题只是收集信息、不落档案
  if (a.questionId !== q.id || q.field === null) return profile;

  switch (q.field) {
    case 'goalStatement':
      return a.kind === 'text' ? commit(profile, { goalStatement: a.value.trim() || null }) : profile;

    case 'deadline':
      return a.kind === 'date'
        ? commit(profile, { deadline: a.value && DATE_RE.test(a.value) ? a.value : null })
        : profile;

    case 'level':
      return a.kind === 'single' && LEVELS.includes(a.value as Level)
        ? commit(profile, { level: a.value as Level })
        : profile;

    case 'weeklyHours':
      return a.kind === 'scale' ? commit(profile, { weeklyHours: a.value }) : profile;

    case 'weekdays':
      // 只认识那七个枚举值。模型可能给出「工作日」这种看着合理、
      // 但存不进 schema 的选项，这里直接过滤掉——写出一个非法 weekday
      // 会让整个档案非法，之后每个请求都 400。
      return a.kind === 'multi'
        ? commit(profile, {
            weekdays: a.values.filter((v): v is Weekday => WEEKDAY_VALUES.includes(v as Weekday)),
          })
        : profile;

    case 'weakSpots':
      return a.kind === 'multi' ? commit(profile, { weakSpots: a.values }) : profile;

    case 'blackouts': {
      if (a.kind !== 'dateRange') return profile;
      const from = a.from.trim();
      const to = a.to.trim();
      const valid = DATE_RE.test(from) && DATE_RE.test(to) && to >= from;
      return commit(profile, { blackouts: valid ? [{ from, to, ...(a.reason ? { reason: a.reason } : {}) }] : [] });
    }
  }
}

/**
 * 档案里还缺哪些关键信息。
 *
 * 用途是**允许跳过但不假装完整**：学生跳过「截止日」，系统不能当没这回事，
 * 而是要在生成计划前明确说「没有截止日，我只能按每周固定量排」。
 */
export function missingProfileFields(p: LearnerProfile): string[] {
  const missing: string[] = [];
  if (!p.goalStatement) missing.push('目标');
  if (!p.deadline) missing.push('截止日');
  if (p.level === null) missing.push('当前水平');
  if (p.weeklyHours === null) missing.push('每周可投入时间');
  if (p.weekdays.length === 0) missing.push('方便的学习日');
  return missing;
}

/** 档案的一句话摘要，用于生成前让学生确认 */
export function describeProfile(p: LearnerProfile): string {
  const bits: string[] = [];
  const levelLabel: Record<NonNullable<LearnerProfile['level']>, string> = {
    beginner: '基本没接触过',
    basic: '学过语法',
    intermediate: '能做简单题',
    advanced: '中等题稳定',
  };
  if (p.level) bits.push(levelLabel[p.level]);
  if (p.weeklyHours !== null) bits.push(`每周约 ${p.weeklyHours} 小时`);
  if (p.weekdays.length) {
    const names: Record<Weekday, string> = {
      mon: '一', tue: '二', wed: '三', thu: '四', fri: '五', sat: '六', sun: '日',
    };
    bits.push(`周${p.weekdays.map((d) => names[d]).join('、')}`);
  }
  if (p.weakSpots.length) bits.push(`薄弱：${p.weakSpots.join('、')}`);
  if (p.blackouts.length) {
    bits.push(`避开 ${p.blackouts.map((b) => `${b.from.slice(5)}~${b.to.slice(5)}`).join('、')}`);
  }
  return bits.join(' · ');
}

/* ------------------------------------------------------------------ *
 * LLM 路径
 * ------------------------------------------------------------------ */

/**
 * 提示词里刻意**不写**「中文学习规划助手」。
 *
 * 这个说法有歧义：「中文·学习规划」（用中文做学习规划）和
 * 「中文学习·规划」（规划怎么学中文）读起来一模一样。
 * 实测模型选了后者，第一题问出「你学中文，主要想解决什么问题？」——
 * 一个歧义短语就让整个产品跑到了别的领域上。
 */
const SYSTEM = `你是一个学习规划助手，用简体中文工作。你的服务对象是中国的大学生，
他们通常在为算法竞赛、专业课考试或自学编程做准备。

你正在通过提问了解一位学生的情况，为制定学习计划做准备。

严格遵守：
1. 你只输出**题目规格**，不输出对话。每一题必须是可渲染成表单控件的结构化题目。
2. 每题的 why 必填，用一句大白话说明「为什么问这个」，站在学生的角度说清这题会影响排期的哪个决定。
3. 不要重复问「已经问过的题」。优先补上档案里还缺的信息。
4. 最多问 8 题。信息够了就返回 done: true，不要再凑题。
5. 语气像一个说话直接的学长：具体、不空洞、不奉承、不打鸡血。
6. 全部用简体中文。日期格式一律 YYYY-MM-DD。

只输出 JSON，不要 markdown 围栏，不要任何解释文字。格式：
{"done": false, "question": {"id": "q_xxx", "field": "goalStatement", "kind": "text", "prompt": "...", "why": "...", "options": [{"value": "...", "label": "..."}], "min": null, "max": null, "step": null, "unit": null, "placeholder": null, "suggestions": []}}
或者信息已足够时：
{"done": true}

**field 决定这题的答案存到哪里，必须和 kind 配对。配错了这题就白问。**
| field | 必须用的 kind | 选项值的要求 |
|---|---|---|
| goalStatement | text | —（学生自己的话） |
| deadline | date | — |
| level | single | 选项值必须是 beginner / basic / intermediate / advanced 之一 |
| weeklyHours | scale | min / max 用**小时** |
| weekdays | multi | 选项值必须是 mon / tue / wed / thu / fri / sat / sun |
| weakSpots | multi | — |
| blackouts | dateRange | — |
| null | 任意 | 这题只是补充了解，不存进档案 |

各 kind 的要求：
· single / multi：必须给至少 2 个 options
· scale：必须给 min 和 max（max > min），建议给 unit
· date / dateRange：placeholder 给一个示例日期（dateRange 给起始日）
· text：可以给最多 4 条 suggestions，点一下就能填进输入框`;

/** 模型输出的外壳。`question` 在 done=false 时必填，这里先宽松收下来再校验 */
export const InterviewOutput = z.object({
  done: z.boolean(),
  question: QuestionSpec.nullable().default(null),
});
export type InterviewOutput = z.infer<typeof InterviewOutput>;

export function buildInterviewMessages(
  profile: LearnerProfile,
  asked: QuestionSpec[],
): { system: string; user: string } {
  const known: string[] = [];
  if (profile.goalStatement) known.push(`目标原话：${profile.goalStatement}`);
  if (profile.deadline) known.push(`截止日：${profile.deadline}`);
  if (profile.level) known.push(`当前水平：${profile.level}`);
  if (profile.weeklyHours !== null) known.push(`每周可投入：${profile.weeklyHours} 小时`);
  if (profile.weekdays.length) known.push(`方便的学习日：${profile.weekdays.join(', ')}`);
  if (profile.weakSpots.length) known.push(`自述薄弱：${profile.weakSpots.join('、')}`);
  if (profile.blackouts.length) {
    known.push(`不可用时间：${profile.blackouts.map((b) => `${b.from}~${b.to}`).join('、')}`);
  }

  return {
    system: SYSTEM,
    user: [
      '【已经了解到的信息】',
      known.length ? known.join('\n') : '（还没有任何信息）',
      '',
      '【已经问过的题】',
      asked.length ? asked.map((q) => `- ${q.prompt}（${q.kind}）`).join('\n') : '（还没问过）',
      '',
      '【还缺的关键信息】',
      missingProfileFields(profile).join('、') || '（都不缺了，可以结束）',
    ].join('\n'),
  };
}

/**
 * 校验模型出的题，不合格就返回 null（调用方回退到本地题库）。
 *
 * 丢掉的情况分三类：
 *   · 结构不合格（选项少于 2 个的单选题、没有区间的 scale）→ 渲染出来是个空壳
 *   · **kind 与 field 不匹配** → 这题的答案根本写不进档案，问了等于没问
 *   · 该字段已经答过 → 按 field 判断而不是按 id，否则模型换个 id 就能再问一遍
 */
export function validateInterviewQuestion(
  output: InterviewOutput,
  profile: LearnerProfile,
  asked: QuestionSpec[],
): QuestionSpec | null {
  if (output.done) return null;
  const q = output.question;
  if (!q) return null;
  if (asked.length >= MAX_QUESTIONS) return null;
  if (asked.some((a) => a.id === q.id)) return null;

  if ((q.kind === 'single' || q.kind === 'multi') && q.options.length < 2) return null;
  if (q.kind === 'scale' && (q.min === null || q.max === null || q.max <= q.min)) return null;

  if (q.field !== null) {
    if (!FIELD_KINDS[q.field].includes(q.kind)) return null;
    if (isFieldAnswered(profile, q.field)) return null;
  }

  return q;
}

/** 这个档案字段是否已经有值了 */
function isFieldAnswered(p: LearnerProfile, f: ProfileField): boolean {
  switch (f) {
    case 'goalStatement':
      return Boolean(p.goalStatement);
    case 'deadline':
      return Boolean(p.deadline);
    case 'level':
      return p.level !== null;
    case 'weeklyHours':
      return p.weeklyHours !== null;
    case 'weekdays':
      return p.weekdays.length > 0;
    case 'weakSpots':
      return p.weakSpots.length > 0;
    case 'blackouts':
      return p.blackouts.length > 0;
  }
}
