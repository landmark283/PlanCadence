/**
 * 线性进度条。
 *
 * 刻意**不做环形进度**：画圆需要 `react-native-svg`，而这个项目到目前为止
 * 零额外原生依赖——为了一个装饰元素去装一个库，收益不抵风险。
 * 细进度条 + 大号数字同样能一眼看清进度，而且和「色调表面」的语言更一致。
 *
 * ## 为什么宽度是补间而不是 scaleX
 *
 * `scaleX` 是纯 transform，性能更好，但要绕开「从中间向两边长」还得靠
 * `transformOrigin`，而且它会把圆角一起拉扁。这是一根 6pt 高的条，
 * 重排的代价可以忽略——用宽度换掉这两个麻烦，值。
 */
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type ViewProps } from 'react-native';

import { easingOut } from '@/lib/motion';
import { motion, radius, useTokens } from '@/theme';

export type ProgressBarProps = {
  /** 0..1，越小越安全。超出会被夹住，避免布局被坏数据撑破 */
  value: number;
  height?: number;
  /** 填充色。默认主色；「已达成」这类场景可以换 success */
  tone?: 'primary' | 'success' | 'warning';
  style?: ViewProps['style'];
};

export function ProgressBar({ value, height = 6, tone = 'primary', style }: ProgressBarProps) {
  const t = useTokens();
  const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

  const anim = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: pct,
      duration: motion.base,
      easing: easingOut,
      // 宽度不是 transform，原生驱动做不了
      useNativeDriver: false,
    }).start();
  }, [pct, anim]);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      style={[styles.track, { height, backgroundColor: t.surfaceSelected, borderRadius: height / 2 }, style]}
    >
      <Animated.View
        style={{
          // 宽度为 0 时不给圆角，否则某些平台会渲染出一个 2px 的圆点
          width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          height: '100%',
          backgroundColor: t[tone],
          borderRadius: pct > 0 ? height / 2 : 0,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    overflow: 'hidden',
    borderRadius: radius.pill,
  },
});
