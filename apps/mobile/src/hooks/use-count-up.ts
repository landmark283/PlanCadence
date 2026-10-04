/**
 * 数字滚动 —— 给「本周 3/5 项 · 120/600 分钟」这类计数用。
 *
 * ## 为什么这里破了「只动 transform 与 opacity」
 *
 * 变的是**文字内容**，不是位置。想只动 transform 就得做成里程表——
 * 每一位竖排 0–9 再整体位移。两位数和三位数要按宽度对齐，
 * 中间还夹着斜杠和「项」「分钟」，代码量会明显超过它带来的观感收益。
 *
 * 所以这里是一次**有意的例外**，代价是 280ms 内每帧一次 re-render。
 * 一屏只有两个数字、且都只是短文本，可以接受；如果哪天真出现掉帧，
 * 再换里程表也来得及。
 *
 * ## 两个容易写错的点
 *
 * 1. 要从**旧值**滚到新值，不能从 0 滚起。从 0 重来会让人以为进度被清零了，
 *    那是错误的语义，不只是难看。
 * 2. 起点取的是**当前屏幕上显示的值**，不是上一次的目标值。连着打两个勾时，
 *    第一次滚动还没结束，取上一次目标值会让数字先跳到那里再往回滚。
 */
import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

import { easingOut } from '@/lib/motion';
import { motion } from '@/theme';

export function useCountUp(value: number, duration: number = motion.slow): number {
  const anim = useRef(new Animated.Value(value)).current;
  const [shown, setShown] = useState(value);
  /** 屏幕上此刻显示的数字。起点要取它，见文件头第 2 条 */
  const shownRef = useRef(value);
  /** 上一次的目标值，用来判断「值真的变了没有」 */
  const target = useRef(value);

  useEffect(() => {
    if (target.current === value) return;
    target.current = value;

    anim.setValue(shownRef.current);
    const id = anim.addListener(({ value: v }) => {
      const next = Math.round(v);
      shownRef.current = next;
      setShown(next);
    });
    const run = Animated.timing(anim, {
      toValue: value,
      duration,
      easing: easingOut,
      // 改的是文字内容，原生驱动做不了，这一条必须走 JS 线程
      useNativeDriver: false,
    });

    run.start(({ finished }) => {
      anim.removeListener(id);
      // 被打断时不写终值：下一次滚动会从当前显示值接着走
      if (finished) {
        shownRef.current = value;
        setShown(value);
      }
    });

    return () => {
      anim.removeListener(id);
      run.stop();
    };
  }, [value, duration, anim]);

  return shown;
}
