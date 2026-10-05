/**
 * 学生档案的读写。
 *
 * ## 它为什么住在计划文件里
 *
 * 这份东西是**关于这个学生的**，不是关于这台设备的：
 *   · 重开 App 它还在（以前只在内存里，重启就忘了——「它不记得我说过的话」）；
 *   · 换设备、把文件发给同学，上下文跟着走——对方看到的不是一份
 *     「只有日期没有来由」的任务表；
 *   · 「跟 AI 说说」和找资料都有依据，不必每次从计划内容反推。
 *
 * ## 为什么 schema 里它是宽松的 `unknown`
 *
 * `PlanFile.profile` 在 `schema.ts` 里是 `z.unknown().nullable()`，
 * 因为 `LearnerProfile` 住在 `llm/interview.ts`，而 schema 层不该反向依赖 llm 层。
 * 真正的校验在这里——而且**校验不过就当没有**：一份坏档案最坏只是「它忘了你说过的话」，
 * 绝不该升级成「文件读不出来」。
 */
import { LearnerProfile } from '../llm/interview.ts';
import type { PlanFile } from './schema.ts';

/** 读出档案。读不出来（没有 / 结构不对）一律给 null，不抛 */
export function readProfile(plan: PlanFile | null | undefined): LearnerProfile | null {
  if (!plan || plan.profile == null) return null;
  const parsed = LearnerProfile.safeParse(plan.profile);
  return parsed.success ? parsed.data : null;
}

/**
 * 写入档案，返回**一份新的计划对象**（不就地改）。
 *
 * 提供在这里而不是让每个调用方自己 `plan.profile = x`：档案的落盘必须和别的
 * 变更走同一条路（改 → 校验 → 序列化 → 写盘），手写一遍迟早会漏掉其中一步。
 *
 * 里面的数组要**逐层复制**，不能只 `{ ...profile }`。
 * 档案在 store 里还有一份镜像（`state.profile`，界面直接读它），浅拷贝会让
 * 计划文件里的档案和那份镜像共用同一个 `weakSpots` 数组——镜像上加一个薄弱点，
 * 计划对象**跟着悄悄变了**，而它并没有进过「改 → 校验 → 写盘」那条路。
 * 那种改动不会报错，只会在某次「读回来的和写下去的对不上」时冒出来。
 */
export function withProfile(plan: PlanFile, profile: LearnerProfile | null): PlanFile {
  return { ...plan, profile: profile ? copyProfile(profile) : null };
}

/** 独立的一份档案：嵌套的数组和对象都要新开 */
function copyProfile(p: LearnerProfile): LearnerProfile {
  return {
    ...p,
    weekdays: [...p.weekdays],
    weakSpots: [...p.weakSpots],
    blackouts: p.blackouts.map((b) => ({ ...b })),
  };
}
