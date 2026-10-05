/**
 * 复盘入口。
 *
 * ## 为什么拆成「动作」和「外观」两件东西
 *
 * 你提过一句：**这个按钮的位置可能随时要改**。所以：
 *
 * · `useReviewLauncher()` —— **打开复盘**这一个动作。任何地方都能调它。
 * · `<ReviewEntry />` —— 只管长什么样，**不认识自己在哪**。
 *
 * 于是换位置是一处改动（把 `<ReviewEntry />` 挪到另一行），
 * 而不是去改每个能触发复盘的按钮。
 *
 * ## 将来「程序主动提示复盘」怎么做
 *
 * 还是调**同一个** `useReviewLauncher()`：比如启动时算一个「该复盘了吗」，
 * 该弹就弹一个提示条 / 弹窗，点它就是这里这个动作。
 * **不需要第二个函数**——这也是我们不预先写一个「算出来但没人调用」的
 * 条件函数的原因（见 `docs/复盘与AI协商方案.md` 2.1）：
 * 那种代码永远不会被触发，也永远不会被测试盯住。
 */
import { useCallback } from 'react';
import { useRouter } from 'expo-router';

import { HeaderAction } from '@/components/screen-header';

/** 打开复盘。入口组件和将来的主动提示共用这一个 */
export function useReviewLauncher(): () => void {
  const router = useRouter();
  return useCallback(() => router.push('/review'), [router]);
}

/**
 * 今日页顶部那个「复盘」。
 *
 * 用 `HeaderAction`（页面级次级动作的既定形态）而不是胶囊：
 * 它和标题同一行、基线对齐，视觉上属于「这一屏的动作」而不是「区块里的动作」。
 */
export function ReviewEntry({ label = '复盘' }: { label?: string }) {
  const openReview = useReviewLauncher();
  return <HeaderAction label={label} accessibilityLabel="开始复盘，把这一周过一遍" onPress={openReview} />;
}
