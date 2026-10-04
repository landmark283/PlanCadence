/**
 * 底部标签导航。
 *
 * 用 `expo-router/js-tabs` 而不是 `expo-router` 的 `Tabs`：
 * SDK 57 里后者已标记 `@deprecated`，指向这个入口（查了 expo-router@57.0.24 的
 * build/exports.d.ts 才确认，按记忆写会踩到弃用警告）。
 *
 * 也不用 `unstable-native-tabs`：前缀就是「不稳定」，而且它渲染的是各平台的
 * 原生 tab 外观，与「平台中立自有语言」的方向冲突。
 *
 * 三个标签而不是四个：Onboarding 是一次性流程，不该常驻在导航里
 * （它挂在 /onboarding，由今日页进入）。
 */
import { Tabs } from 'expo-router/js-tabs';

import { AppTabBar } from '@/components/app-tab-bar';

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <AppTabBar {...props} />}
      screenOptions={{ headerShown: false }}
      // 顺序即底部从左到右的顺序；今日放第一，因为它是停留最久的一屏
      initialRouteName="index"
    >
      <Tabs.Screen name="index" options={{ title: '今日' }} />
      <Tabs.Screen name="review" options={{ title: '复盘' }} />
      <Tabs.Screen name="resources" options={{ title: '资源' }} />
      {/* 「文件」独立成一个标签页而不是塞进某个二级入口：
          演示时要能直接翻到 .studyplan 本体 */}
      <Tabs.Screen name="file" options={{ title: '文件' }} />
    </Tabs>
  );
}
