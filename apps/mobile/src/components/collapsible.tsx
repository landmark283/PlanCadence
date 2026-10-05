/**
 * 高度可动画的折叠区。任务卡的「调整」面板用它。
 *
 * ## 为什么要量高度
 *
 * `height: 'auto'` 没法动画。而写一个固定的上限（比如 400）会让曲线失真：
 * 内容只有 120 高时，前 30% 的时间里看不出任何变化，然后猛地弹开。
 * 所以先把内容量出来，再动到那个真实高度。
 *
 * ## 收起之后要卸载
 *
 * 高度到 0 不等于不存在。子树一直挂着的话，里面的胶囊仍然能被读屏摸到、
 * 被 Tab 键选中——一个「已经收起」的面板却还是可聚焦的，这比不做动效更糟。
 * 所以收起动画结束后才卸载。
 *
 * ## 内容高度变化时跟着动
 *
 * 面板里会出现按状态增减的行（勾上「完成」就多出「实际」那一行）。
 * 高度变了还硬停在旧值上会切掉内容，所以 `contentH` 一变就再动一次。
 *
 * ## 量不到高度就放弃动画（这条兜底别删）
 *
 * 「调整」按钮失效曾经还有一个**在开发环境里排不掉**的可能：面板展开依赖
 * `onLayout` 量高度，而如果原生上它不触发，`contentH` 永远是 0、高度停在 0——
 * 表现和「按钮坏了」一模一样。web 上它工作正常，所以截图和探针都证明不了它没问题。
 *
 * 所以展开后 `MEASURE_TIMEOUT` 毫秒还没量到高度，就**直接把内容渲染出来**：
 * 代价是最坏情况下没有展开动画，换来的是「它一定会打开」。
 * 一个不带动画但打得开的面板，远好过一个漂亮但打不开的。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, View, type ViewProps } from 'react-native';

import { easingOut } from '@/lib/motion';
import { motion } from '@/theme';

/** 超过这么久还没量到高度，就认为量不出来了 */
const MEASURE_TIMEOUT = 300;

export type CollapsibleProps = {
  open: boolean;
  children: ReactNode;
  style?: ViewProps['style'];
};

export function Collapsible({ open, children, style }: CollapsibleProps) {
  /** 内容撑开的真实高度。0 表示还没量到 */
  const [contentH, setContentH] = useState(0);
  /** 收起动画播完才能卸载子树，否则内容会瞬间消失 */
  const [mounted, setMounted] = useState(open);
  /** 量高度这件事失败了。见文件头那条兜底 */
  const [measureFailed, setMeasureFailed] = useState(false);
  const height = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    if (!open) {
      // 下一次展开重新给一次机会：原生上可能只是这一次慢了
      setMeasureFailed(false);
      return;
    }
    if (contentH > 0) return;
    const timer = setTimeout(() => setMeasureFailed(true), MEASURE_TIMEOUT);
    return () => clearTimeout(timer);
  }, [open, contentH]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!mounted) return;

    Animated.parallel([
      Animated.timing(height, { toValue: 0, duration: motion.base, easing: easingOut, useNativeDriver: false }),
      Animated.timing(fade, { toValue: 0, duration: motion.fast, easing: easingOut, useNativeDriver: false }),
    ]).start(({ finished }) => {
      // 中途又被展开时不要卸载，否则会闪一下空白
      if (finished) setMounted(false);
    });
  }, [open, mounted, height, fade]);

  useEffect(() => {
    if (!open || contentH === 0) return;
    Animated.parallel([
      Animated.timing(height, { toValue: contentH, duration: motion.base, easing: easingOut, useNativeDriver: false }),
      Animated.timing(fade, { toValue: 1, duration: motion.base, easing: easingOut, useNativeDriver: false }),
    ]).start();
  }, [open, contentH, height, fade]);

  /**
   * 兜底分支：不做动画，内容直接出现/消失。
   *
   * 这里**不能**再挂 `onLayout` 试图补救——它要是不触发，挂上去也不会触发，
   * 而那正是走到这个分支的原因。
   */
  if (measureFailed) {
    return open ? <View style={style}>{children}</View> : null;
  }

  if (!mounted) return null;

  return (
    <Animated.View style={[style, { height, opacity: fade, overflow: 'hidden' }]}>
      {/* 量的必须是内层：外层的高度是我们自己控制的，拿它做依据会自己咬自己 */}
      <View onLayout={(e) => setContentH(e.nativeEvent.layout.height)}>{children}</View>
    </Animated.View>
  );
}
