/**
 * 勾选控件 —— 全应用唯一的「打勾」交互。
 *
 * 刻意**不用** RN 的 `Switch`：
 *  1. 它表达的是「设置项的开关」，而这里是「采纳一条建议」/「完成一个任务」，语义不对；
 *  2. 在 react-native-web 上它不完全吃 `trackColor`/`thumbColor`，
 *     实机渲染出的配色会和设计系统对不上（第一次截图就是紫轨道配绿圆点）。
 *
 * 也不做成描边胶囊按钮：每张卡一个胶囊会让强调色在一屏里出现四五次，
 * 违反 `color-limit-accents`。勾选框的墨量刚好。
 *
 * ## 动效
 *
 * 方框的填充色是**一个盖上去的实心层在淡入**，不是背景色在补间。
 * 颜色补间走不了原生驱动，而一屏会有五六个勾选框——
 * 多盖一层换整条动画留在 UI 线程上，值。
 * 勾号本身同时从 0.6 缩放到 1，让「点到了」这件事有一下回应。
 */
import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet, View, type ViewProps } from 'react-native';

import { AppText } from '@/components/app-text';
import { easingOut } from '@/lib/motion';
import { motion, radius, space, touchTarget, useTokens } from '@/theme';

export type CheckControlProps = {
  checked: boolean;
  /**
   * 勾选框右侧的文字。
   *
   * 不传就是「光方框」模式：任务卡里标题本身就是标签，再加一个「完成」会重复。
   * 这种模式下靠 `hitSlop` 把 20pt 的方框补到 44pt 的触控区
   * （规则 `resp-touch-target-size`），视觉尺寸不变。
   */
  label?: string;
  /** 无障碍朗读的是**动作**，不是状态——读屏用户需要知道点下去会发生什么 */
  accessibilityLabel: string;
  onToggle: () => void;
  style?: ViewProps['style'];
};

/** 勾选框的三个尺寸。方框和填充层必须用同一组，否则圆角会露出边框 */
const BOX = 20;
const BOX_RADIUS = radius.sm - 2;
const BOX_BORDER = 1.5;

export function CheckControl({ checked, label, accessibilityLabel, onToggle, style }: CheckControlProps) {
  const t = useTokens();
  const bare = label === undefined;

  /** 0 = 未勾，1 = 已勾。填充层和勾号都由它推出来 */
  const progress = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: checked ? 1 : 0,
      duration: motion.fast,
      easing: easingOut,
      useNativeDriver: true,
    }).start();
  }, [checked, progress]);

  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={accessibilityLabel}
      onPress={onToggle}
      hitSlop={bare ? 12 : 8}
      style={({ pressed }) => [bare ? styles.bare : styles.row, pressed ? styles.pressed : null, style]}
    >
      <View style={[styles.box, { borderColor: checked ? t.primary : t.borderStrong }]}>
        {/* 填充层。盖在边框内圈上，所以不需要跟着动画改边框色 */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: t.primary, borderRadius: BOX_RADIUS - BOX_BORDER, opacity: progress },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={{
            opacity: progress,
            transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }],
          }}
        >
          <AppText variant="caption" tone="onPrimary">
            ✓
          </AppText>
        </Animated.View>
      </View>
      {label !== undefined ? (
        <AppText variant="label" tone={checked ? 'primary' : 'textMuted'}>
          {label}
        </AppText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.sm,
    minHeight: touchTarget,
    marginTop: space.xs,
  },
  /**
   * 光方框模式：`marginTop: 2` 让方框中线落在相邻标题第一行的中线上
   * （label 变体行高 24，标题行高 24，所以 2pt 的偏移刚好对齐）。
   */
  bare: {
    marginTop: 2,
  },
  pressed: {
    opacity: 0.6,
  },
  box: {
    width: BOX,
    height: BOX,
    borderRadius: BOX_RADIUS,
    borderWidth: BOX_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    // 填充层要贴着内圈，圆角才不会溢到边框上
    overflow: 'hidden',
  },
});
