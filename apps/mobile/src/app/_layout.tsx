/**
 * 根布局。
 *
 * 这里挂 `PlanProvider`：四屏共享同一份计划状态，
 * 所以在今日页打勾，切到复盘页就能看到引擎基于新状态重新给的调整——
 * 这条链路是演示的主线，状态必须活在导航之上，不能挂在某一屏里。
 *
 * 这里还负责把导航容器本身的主题对齐到我们自己的令牌：
 * expo-router 默认用 React Navigation 的 `DefaultTheme`，它的
 * `colors.background` 是固定的 `#F2F2F2`。只要有一屏忘了画背景，
 * 透出来的就是这个纯白——深色模式下就成了白底白字（真实事故，见 components/screen.tsx）。
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';

import { PlanProvider } from '@/state/plan-store';
import { useScheme, useTokens } from '@/theme';

export default function RootLayout() {
  const scheme = useScheme();
  const t = useTokens();

  const navTheme = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === 'dark',
      colors: {
        ...base.colors,
        primary: t.primary,
        background: t.bg,
        card: t.surface,
        text: t.text,
        border: t.border,
        notification: t.danger,
      },
    };
  }, [scheme, t]);

  return (
    <PlanProvider>
      <ThemeProvider value={navTheme}>
        {/* auto：跟随系统深浅色，深色模式下状态栏文字自动转白 */}
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: 'transparent' },
            animation: 'fade',
          }}
        />
      </ThemeProvider>
    </PlanProvider>
  );
}
