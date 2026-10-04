/**
 * 动效的两个共用零件。
 *
 * 时长和曲线本身在 `theme/tokens.ts` 里（`motion` / `easeOut`），
 * 这里只做一件 tokens 不该做的事：把四个数转成 RN 的 `Easing` 对象。
 * tokens 是纯数据，不 import react-native——它还要能在别处被读。
 */
import { Animated, Easing } from 'react-native';

import { easeOut, motion } from '@/theme';

/** 全应用唯一的出曲线。cubic-bezier(0.23, 1, 0.32, 1) */
export const easingOut = Easing.bezier(easeOut[0], easeOut[1], easeOut[2], easeOut[3]);

/**
 * 统一的 timing 配置。
 *
 * 集中在一处是为了让「所有动效都是 220ms + 同一条曲线」这件事**只有一处定义**——
 * 散在各个组件里写，第一次微调就会漂移出四五种手感。
 */
export function timing(
  value: Animated.Value,
  toValue: number,
  duration: number = motion.base,
  native = true,
) {
  return Animated.timing(value, { toValue, duration, easing: easingOut, useNativeDriver: native });
}
