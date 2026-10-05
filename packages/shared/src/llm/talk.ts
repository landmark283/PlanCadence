/**
 * `talk` 契约 —— 学生说一句话，系统回一张待确认卡。
 *
 * ## 这一份的核心不是提示词，是**把关**
 *
 * 提示词里写「不要编 id」「不确定就问」是**没有约束力**的——这个项目已经吃过
 * 一次亏（「保留学生原话」写在提示词里，模型照样润色）。所以这一份里真正重要的是
 * `resolveTalkOutput`：它把模型给的东西**逐条过一遍**，过不了的丢掉并说明原因。
 *
 * ## 三条硬规则（都在代码里，不在提示词里）
 *
 *  1. **有澄清问题就绝不同时给提案。** 猜着改是被禁止的，不是「尽量别」。
 *  2. **任务只认计划里已有的 id。** 编出来的 id 过不了 `validateProposal`。
 *  3. **日期要被校验**（合法、不早于今天、不落在 blackout、不早于 notBefore）。
 *     过不了的那条丢掉，并把理由交给界面说给学生听——
 *     「我没敢动 X，因为算出来的日期落在你的期中考试周」比默默少一条好得多。
 *
 * ## 对话状态只有一个来源：`history`
 *
 * 学生的话、AI 的复述与问题、学生对问题的回答——**全部是 history 里的轮次**。
 * 不另设一个 `answers` 字段：那会变成同一件事的第二个表示，
 * 而且两边迟早对不上（谁先谁后、答了没答）。
 */
import { z } from 'zod';

import { DateStr } from '../plan/schema.ts';
import { Proposal, validateProposal } from '../plan/proposal.ts';
import type { PlanFile } from '../plan/schema.ts';
import { LearnerProfile, QuestionSpec } from './interview.ts';

/** 一次会话最多带几轮上下文。太多轮既费 token，也没必要 */
export const MAX_TALK_TURNS = 8;
/** 一次最多给几条提案。再多学生就不看了 */
export const MAX_TALK_PROPOSALS = 6;
/** 最多反问几个。两个以上就开始像填表 */
export const MAX_TALK_QUESTIONS = 2;
/**
 * 最多澄清几轮。
 *
 * **这一条必须由代码兜住，不能只写在提示词里。** 实测出来的：
 * 学生说「周三那两项挪到周末」，模型先问「是哪两项」，回答之后它又问
 * 「周六还是周日」——它一直在问，**一条提案都不给**。
 * 这正是「一直问、什么都不做」，而它比答错更让人烦。
 *
 * 到了上限就必须给出提案，或者明说做不到。
 */
export const MAX_CLARIFY_ROUNDS = 2;

/** 到这一轮为止，AI 已经问过几次（history 里 questions 非空的轮数） */
export function clarifyRounds(history: TalkTurn[]): number {
  return history.filter((t) => t.role === 'ai' && t.questions.length > 0).length;
}

/* ------------------------------------------------------------------ *
 * 输入
 * ------------------------------------------------------------------ */

export const TalkTurn = z.discriminatedUnion('role', [
  z.object({ role: z.literal('student'), text: z.string().min(1).max(500) }),
  z.object({
    role: z.literal('ai'),
    understanding: z.string().max(600),
    questions: z.array(QuestionSpec).max(MAX_TALK_QUESTIONS),
  }),
]);
export type TalkTurn = z.infer<typeof TalkTurn>;

export const TalkInput = z.object({
  /** 计划原文。和别的接口一样「文本进、文本出」，服务端不持状态 */
  plan: z.string().min(1),
  today: DateStr,
  profile: LearnerProfile.nullable().default(null),
  history: z.array(TalkTurn).min(1).max(MAX_TALK_TURNS),
});
export type TalkInput = z.infer<typeof TalkInput>;

/** 学生对一个反问的回答，压成一句学生口吻的话塞进 history */
export function answerTurn(question: string, answerLabel: string): TalkTurn {
  return { role: 'student', text: `（回答「${question}」：${answerLabel}）` };
}

/* ------------------------------------------------------------------ *
 * 模型输出
 * ------------------------------------------------------------------ */

/**
 * 模型要产出的东西。
 *
 * `proposals` 刻意是 `z.array(z.unknown())`：**逐条 **单独** 校验**，
 * 一条坏的不能拖垮整批。这和 `plan.attachResources` 里「单条资源不合法只跳过它」
 * 是同一个道理——模型一次给六条建议，第三条的日期算错了，
 * 学生不该因此连另外五条都看不到。
 */
export const TalkOutput = z.object({
  /** 我先说一遍我听懂了什么 */
  understanding: z.string().min(1).max(600),
  /**
   * 问题与提案的**schema 上限刻意比实际用的宽**（4 / 12 对 2 / 6）。
   *
   * 为什么：schema 是**解析**，解析一失败整条回复就废了——学生什么都拿不到。
   * 模型偶尔多给一个问题是常事，那时候应该**砍掉多的那条**而不是把整条回复丢掉。
   * 真正的上限在 `resolveTalkOutput` 里（那里能逐条处理）。
   */
  questions: z.array(QuestionSpec).max(4).default([]),
  proposals: z.array(z.unknown()).max(12).default([]),
  /** 做不到的事，用学生看得懂的话说 */
  refusals: z.array(z.string().max(200)).max(4).default([]),
  /** 收尾一句。可以是空的 */
  close: z.string().max(300).default(''),
});
export type TalkOutput = z.infer<typeof TalkOutput>;

export type TalkResult = {
  understanding: string;
  questions: QuestionSpec[];
  proposals: Proposal[];
  refusals: string[];
  close: string;
  /** 被丢掉的条数（格式不对或对不上计划）。用于日志与自证 */
  dropped: number;
};

/**
 * 把关：把模型给的东西变成**能直接上界面**的结果。
 *
 * 纯函数，所以单测能直接打它——`talk` 这条路最难的部分就是这里，
 * 而它不需要网络、不需要模型。
 */
export function resolveTalkOutput(
  output: TalkOutput,
  plan: PlanFile,
  today: string,
  opts: { rounds?: number } = {}
): TalkResult {
  const refusals = [...output.refusals];
  let dropped = 0;

  const proposals: Proposal[] = [];
  for (const raw of output.proposals) {
    if (proposals.length >= MAX_TALK_PROPOSALS) {
      dropped++;
      continue;
    }
    const parsed = Proposal.safeParse(raw);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    const check = validateProposal(parsed.data, plan, today);
    if (!check.ok) {
      dropped++;
      // 理由交到界面上说给学生听。这是「做不到的事明说」的一部分：
      // 少了一条却什么都不说，学生只会觉得它没听懂
      refusals.push(`我没敢动这一条：${check.reason}`);
      continue;
    }
    proposals.push(parsed.data);
  }

  const questions = output.questions.slice(0, MAX_TALK_QUESTIONS);

  /**
   * **规则 4：澄清不能没完没了。**（必须排在规则 1 前面）
   *
   * 顺序很重要，而这里踩过一次：如果先跑规则 1，模型「同时给了问题和提案」时
   * 提案会先被砍掉，然后规则 4 再把问题砍掉——**两边都没了，学生拿到一个空屏幕**。
   * 到上限时该做的是「不许再问、把提案留下」。
   *
   * 如果它除了问题什么都没给，那学生手上就真的什么都没有，这时候**必须说出来**：
   * 静默地显示一个空屏幕，学生会以为程序坏了。
   */
  const rounds = opts.rounds ?? 0;
  if (rounds >= MAX_CLARIFY_ROUNDS && questions.length > 0) {
    dropped += questions.length;
    questions.length = 0;
    if (!proposals.length) {
      refusals.push('我以为已经问清楚了，但看来还没有。你可以换句话再说一遍，或者直接在卡片上手动改。');
    }
  }

  /**
   * **规则 1：有澄清问题就绝不同时给提案。**
   *
   * 模型两样都给的时候在这里砍掉提案——猜着改是禁止的。
   * 学生回答之后会走下一轮，那一轮再给提案。
   */
  if (questions.length > 0 && proposals.length > 0) {
    dropped += proposals.length;
    proposals.length = 0;
  }

  return {
    understanding: output.understanding,
    questions,
    proposals,
    refusals,
    close: output.close,
    dropped,
  };
}

/* ------------------------------------------------------------------ *
 * 提示词
 * ------------------------------------------------------------------ */

/**
 * 提示词。
 *
 * 这里写的规则是**给模型的行事说明**，不是安全边界——边界在
 * `resolveTalkOutput` 里。两者都要有：提示词让它大多数时候做对，
 * 把关让它做错的时候伤不到计划。
 */
export function buildTalkMessages(input: TalkInput): { system: string; user: string } {
  const system = `你是学习计划助手。学生会对自己的计划说一句话，你要判断他想改什么。

输出一个 JSON 对象，字段：
{
  "understanding": "我先说一遍我听懂了什么（一到两句，用学生的口吻，不要客套）",
  "questions": [ 需要澄清时的问题，最多 ${MAX_TALK_QUESTIONS} 个，否则空数组 ],
  "proposals": [ 你建议的改动，最多 ${MAX_TALK_PROPOSALS} 条，否则空数组 ],
  "refusals": [ 你做不到的事，最多 4 条，用学生看得懂的话 ],
  "close": "一句收尾，可以是空字符串"
}

问题（questions）的每一项：
{ "id":"q_xxx", "field":null, "kind":"single", "prompt":"问题本身",
  "why":"这题为什么重要", "options":[{"value":"a","label":"选项一"}], "suggestions":[] }

提案（proposals）的每一项，kind 与字段：
- {"kind":"reschedule","taskId":"<计划里的任务 id>","scheduledFor":"YYYY-MM-DD 或 null","reason":"为什么"}
- {"kind":"estimate","taskId":"<id>","estimateMin":60,"reason":"为什么"}
- {"kind":"task","taskId":"<id>","patch":{"title":"...","notes":"...","estimateMin":60,"scheduledFor":null},"reason":"为什么"}
- {"kind":"goal","patch":{"statement":"...","deadline":"YYYY-MM-DD","priority":"low|medium|high"},"reason":"为什么"}
- {"kind":"addTask","task":{"title":"...","type":"read|practice|project|review|assess","estimateMin":45,"notes":"","scheduledFor":null,"tags":[]},"reason":"为什么"}
- {"kind":"dropTask","taskId":"<id>","reason":"为什么"}
- {"kind":"profile","patch":{"weeklyHours":3,"weekdays":["mon","wed"],"weakSpots":["动态规划"]},"reason":"为什么"}
每条提案都要有 "engineReason"，值是同一句理由的原文（你不改写它时就和 reason 一样）。

铁律：
1. **只提议，不要改计划。** 改动要学生逐条确认之后由程序应用。
2. **taskId 必须来自上面计划里已有的 id。** 不许自己编 id——编出来的会被丢掉。
3. **日期用 YYYY-MM-DD 绝对值。** 它会被程序校验（不能是过去、不能落在学生的不可用区间、
   不能早于学生设过的「最早可安排日」）。日期的算术（「周末」是哪两天）由程序做，你不用管。
4. **没把握就问，不要猜着改。** 如果给了 questions，proposals 必须是空数组——
   程序会强制这一点，你同时给的话提案会被丢掉。
5. **做不到的事放进 refusals**，比如「删掉整份计划重做」不在你的范围里。
6. **不要润色学生的原话。** 改目标时改的是内容，不是语气。`;

  const convo = input.history
    .map((t) =>
      t.role === 'student'
        ? `学生：${t.text}`
        : `你：${t.understanding}${t.questions.length ? `\n（你问了：${t.questions.map((q) => q.prompt).join(' / ')}）` : ''}`
    )
    .join('\n');

  const profile = input.profile
    ? `\n学生档案：${JSON.stringify(input.profile)}`
    : '\n学生档案：（还没有）';

  /**
   * 把「还剩几轮可以问」直接告诉模型。
   *
   * 代码那边有兜底（问满上限就砍掉问题），但让模型**知道**上限在哪，
   * 它就会在这一轮把提案写出来，而不是被砍成一个空屏幕。
   */
  const asked = clarifyRounds(input.history);
  const left = MAX_CLARIFY_ROUNDS - asked;
  const askRule =
    left > 0
      ? `你还可以澄清 ${left} 轮。`
      : '**你已经问过两轮了，这一轮不能再问，必须给出 proposals 或把做不到的写进 refusals。**';

  const user = `今天是 ${input.today}。${profile}

下面是他的计划全文：
---
${input.plan}
---

最近这几轮对话：
${convo}

${askRule}

请输出 JSON。`;

  return { system, user };
}
