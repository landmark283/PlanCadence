/**
 * id 生成 —— 纯函数，不读时钟、不读随机数。
 *
 * ## 为什么不用时间戳或随机数
 *
 * `applyCommand` 是纯函数，可回放、可复现；调用方（界面）也不该为了「建一条任务」
 * 去读一次时钟——那会让同一次操作在两次渲染里产生不同的结果，而
 * `plan-store.tsx` 的文件头已经写明「时钟读数放进 reducer 会让 StrictMode 下的
 * 两次调用产生不同的时间戳」。
 *
 * ## 为什么是序号而不是随机串
 *
 * 这个格式里既有的任务 id 就是 `t_01` 这样（`llm/planner.ts` 给模型产出的也是
 * 这个风格）。一个格式里出现两种 id 风格，读文件的人就得先分辨是哪一种。
 * 所以沿用它：扫出已有的最大序号，往后取一个没被占用的。
 *
 * 注意 `Id` 的正则很严：`^[a-z][a-z0-9_]{0,31}$`。`t_07` 满足；带连字符或者
 * 大写的写法都不满足，**这个约束有测试盯着**（用 schema 导出的 `Id` 去验）。
 */

/** 只认「前缀_数字」；`t_a`、`t_01b` 这类手写的 id 不参与编号 */
const NUMBERED = /^t_(\d+)$/;

/** 顺延的上限。真撞满 1000 个说明数据已经坏了，那时候报错比悄悄覆盖别人的 id 好 */
const MAX_PROBE = 1000;

/**
 * 给新任务取一个 id。
 *
 * `existing` 是**计划里现有的全部 task id**。取最大值 +1 而不是「找第一个空位」：
 * 空位会重用刚被删掉的任务 id，而历史里还留着 `t_03` 这个名字，
 * 以后对不上账时没人分得清那是同一件事的延续还是另一件事。
 */
export function newTaskId(existing: readonly string[]): string {
  const used = new Set(existing);
  let max = 0;
  for (const id of existing) {
    const m = NUMBERED.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (let n = max + 1; n <= max + MAX_PROBE; n++) {
    // padStart(2) 只对 1–99 补零；100 以上自然就是 t_100，仍然合法
    const id = `t_${String(n).padStart(2, '0')}`;
    if (!used.has(id)) return id;
  }
  throw new Error(`生成任务 id 失败：连续 ${MAX_PROBE} 个候选都被占用了`);
}
