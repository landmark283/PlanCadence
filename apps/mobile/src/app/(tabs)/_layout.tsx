/**
 * 底部标签导航：**三个**——今日 / 资源 / 文件。
 *
 * ## 复盘为什么不在这里
 *
 * 它挂在 `/review`（**推入的整屏**），入口在今日页顶部（`<ReviewEntry />`）。
 * 理由是：标签栏表达的是「一个你随时可以回来的地方」，而复盘是
 * 「一件有开始有结束的事」——走完就回今日页，那个位置不该一直杵着催人；
 * 它也不该变成「一个我从来没打开过的页面」。
 *
 * ## 为什么用 `expo-router/js-tabs`
 *
 * 而不是 `expo-router` 的 `Tabs`：SDK 57 里后者已标记 `@deprecated`，
 * 指向这个入口（查了 expo-router@57.0.24 的 build/exports.d.ts 才确认，
 * 按记忆写会踩到弃用警告）。
 *
 * 也不用 `unstable-native-tabs`：前缀就是「不稳定」，而且它渲染的是各平台的
 * 原生 tab 外观，与「平台中立自有语言」的方向冲突。
 *
 * ## 为什么 Onboarding 也不在导航里
 *
 * 它是一次性流程（学生不会想重做一遍访谈），挂在 `/onboarding`，
 * 由文件页的「演示用」区进入。
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
      <Tabs.Screen name="resources" options={{ title: '资源' }} />
      {/* 「文件」独立成一个标签页而不是塞进某个二级入口：
          演示时要能直接翻到 .studyplan 本体 */}
      <Tabs.Screen name="file" options={{ title: '文件' }} />
    </Tabs>
  );
}
