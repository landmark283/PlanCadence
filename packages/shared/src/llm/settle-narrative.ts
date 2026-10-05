/**
 * 补账叙述 —— 让模型把「这几天发生了什么」说成人话。
 *
 * ## 这一层能拿到的信息是**被限制过的**
 *
 * 提示词里给模型的不是整份计划，而是 `SettleNarrativeInput`：
 * 过了几天、几项没做、每项压了多久、挡着几个后继、有没有过截止日。
 * 它看不到任务 id、看不到排期内部结构、看不到 `compress.plan`。
 *
 * 这是刻意的：给它看不见的东西，它就没机会基于那些东西编话。
 *
 * ## 光在提示词里写「不要改数字」是没有约束力的
 *
 * 所以真正的约束在校验那一侧：`narrativeNumbersOk` 会拿模型写出来的
 * 每一个整数去比对白名单，出现白名单之外的数字就整段退回本机叙述。
 * 见 `plan/settle.ts` 里那段注释——数字数错是这一屏唯一不能犯的错。
 */
import { z } from 'zod';
import type { SettleNarrativeInput } from '../plan/settle.ts';

export const SettleNarrativeOutput = z.object({
  /** 2–3 句。清单本身就在这段文字正下方，所以不要复述清单 */
  narrative: z.string().min(1).max(1200),
});
export type SettleNarrativeOutput = z.infer<typeof SettleNarrativeOutput>;

const SYSTEM = `你是一个学习计划助手。学生隔了几天没有打开计划，现在回来了。
系统已经算好了这段时间的实际情况（过了几天、哪几项没做、每项压了多久、挡着几个后续任务）。
你的任务只是把这段情况说成 2–3 句平实的中文。

硬性要求：
1. **只能使用给定信息里出现过的数字。** 不要做任何加法、减法、估算，
   不要引入任何新的数字。给定信息里没有提到的数量，就不要提。
2. 不要罗列清单——那几项的标题和日期已经显示在这段文字的正下方了，
   复述一遍是浪费。你要说的是"这意味着什么"。
3. 语气平实，像一个了解情况的人在陈述事实。不要鼓励、不要劝学、
   不要说"加油""不要气馁""相信你可以"这类话，也不要评判学生。
4. 不要给建议、不要提出具体的补救方案——该由学生决定的事，界面上会问他。
5. 不要提到"系统""算法""数据"这些词，就像你自己看出来的。

只输出 JSON。`;

const LINE = (label: string, value: string) => `- ${label}：${value}`;

export function buildSettleNarrativeMessages(input: SettleNarrativeInput): { system: string; user: string } {
  const pendingText = input.pending.length
    ? input.pending
        .map((p) => `- ${p.title}（原定 ${p.scheduledFor}，预估 ${p.estimateMin} 分钟，挡着 ${p.blocks} 项）`)
        .join('\n')
    : '（没有）';

  const user = `## 系统算好的事实（只能用这里的数字）
${LINE('上次打开', input.from)}
${LINE('现在', input.to)}
${LINE('中间过了几天', String(input.daysPassed))}
${LINE('这段时间本该完成、但没打勾的项数', String(input.pending.length))}
${LINE('这段时间里已经完成的项数', String(input.doneCount))}
${LINE('目标截止日已经过去', input.pastGoalDeadline ? '是' : '否')}
${LINE('截止日已过但仍有未完成任务的里程碑', input.atRiskMilestones.length ? input.atRiskMilestones.join('、') : '无')}

## 学生原本的目标
${input.goalStatement}

## 没做的清单
${pendingText}

## 系统自己写的一版（语气参考，不要照抄，也不要沿用它的措辞）
${input.localText}

请按系统提示的 JSON 格式输出。`;

  return { system: SYSTEM, user };
}
