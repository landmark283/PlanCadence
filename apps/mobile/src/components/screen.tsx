/**
 * 屏幕容器 —— 每一屏的最外层。
 *
 * 存在的理由是一个真实事故：今日页的根 View 只写了 `flex: 1`，忘了设背景色，
 * 于是露出了 React Navigation `DefaultTheme` 的 `#F2F2F2`（纯白）。
 * 浅色主题下白底白字看不出来，**深色主题下就变成近白色的文字压在白底上**，
 * 标题对比度掉到 1.01:1——等于隐形。而复盘页、资源页各自设了背景，所以没事。
 *
 * 「每屏都记得写 backgroundColor」是靠不住的。把它收进一个容器组件之后，
 * 忘记设置这件事在构造上就不可能发生。
 */
import { StyleSheet, View, type ViewProps } from 'react-native';

import { useTokens } from '@/theme';

export function Screen({ style, ...rest }: ViewProps) {
  const t = useTokens();
  return <View style={[styles.screen, { backgroundColor: t.bg }, style]} {...rest} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
