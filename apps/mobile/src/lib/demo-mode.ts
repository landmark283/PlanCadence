/**
 * 演示保险：强制所有模型与网络调用走本机路径。
 *
 * ## 它防的不是「断网」
 *
 * 这个 App 的每一条 AI 路径本来就有本机兜底，**断网是安全的**——请求会立刻失败，
 * 然后几毫秒内退回本机。真正会在现场出事的是相反的情况：
 *
 * > 场地 Wi-Fi 通着，但模型 API 连不上（被墙、额度用完、服务在抖动）。
 *
 * 这时 `postJson` 不会立刻失败，它会**一直等到超时**——生成计划那条的超时是
 * **90 秒**。台上站着等 90 秒，比"它答得不好"严重得多。
 *
 * 所以这个开关的作用是**把不确定性摘掉**：打开之后一次网络请求都不发，
 * 全部即时走本机。答辩/录屏前打开，就不用赌场地网络。
 *
 * ## 为什么是模块级标志而不是 React 状态
 *
 * 用它的是 `lib/api.ts`——一个纯模块，不是组件，拿不到 context。
 * 做成模块级标志 + `useSyncExternalStore`，两边都能读到同一份真相，
 * 而且不需要把 api.ts 改成 hook 风格。
 */
import { useSyncExternalStore } from 'react';

let offlineOnly = false;
const listeners = new Set<() => void>();

export function isOfflineOnly(): boolean {
  return offlineOnly;
}

export function setOfflineOnly(next: boolean): void {
  if (offlineOnly === next) return;
  offlineOnly = next;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 组件里读当前状态。用 `useSyncExternalStore` 而不是 useState，
 *  因为它读的就是那个模块级标志本身，不存在"状态和标志不同步"的可能 */
export function useOfflineOnly(): boolean {
  return useSyncExternalStore(subscribe, isOfflineOnly, () => false);
}

/** 打开时附在降级说明后面的那句话，让界面上说清楚为什么走了本机 */
export const OFFLINE_NOTE = '演示模式：只用本机';
