/**
 * 「跟 AI 说说」的入口 —— 今日页右下角那个常驻按钮。
 *
 * ## 和复盘入口一样，动作与外观分开
 *
 * `useTalkLauncher()` 是动作，`<TalkEntry />` 只管长什么样。
 * 换位置是一处改动。
 *
 * ## 为什么是浮在内容上的胶囊，而不是标签栏中间那一格
 *
 * 标签栏表达的是「几个并列的去处」，而这个是一个**动作**。
 * 把它塞进标签栏会让「今日/资源/文件」多出一个不同性质的东西，
 * 而且它其实是一次性的（说完就走）。浮层没有这个问题。
 *
 * 代价：它会盖住滚动内容右下角。所以今日页的滚动区底部留白
 * 特意留出了它的高度（见 `(tabs)/index.tsx` 的 `scroll.paddingBottom`）。
 */
import { useCallback } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/app-text';
import { radius, screenPadding, space, touchTarget, useTokens } from '@/theme';

/** 打开「跟 AI 说说」。和手动触发共用一个，将来别处要入口也是调它 */
export function useTalkLauncher(): () => void {
  const router = useRouter();
  return useCallback(() => router.push('/talk'), [router]);
}

export function TalkEntry({ label = '跟 AI 说说' }: { label?: string }) {
  const t = useTokens();
  const open = useTalkLauncher();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="跟 AI 说说你的计划"
      onPress={open}
      style={({ pressed }) => [
        styles.fab,
        { backgroundColor: t.primary, opacity: pressed ? 0.85 : 1 },
      ]}
    >
      <AppText variant="subtitle" tone="onPrimary">
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: screenPadding,
    bottom: space.lg,
    minHeight: touchTarget,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
