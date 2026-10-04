/**
 * 横向周条 —— 「本周负载」的一眼可见形态。
 *
 * 每一天是一格，格子里从上到下是「周几 / 日号 / 负载条」。
 * 负载条用长度而不是颜色表达多少：颜色已经被状态占用了，
 * 再来一套颜色编码，学生就得同时维护两张对照表。
 */
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { dayOfMonth, weekdayShort } from '@/lib/dates';
import { radius, space, touchTarget, useTokens } from '@/theme';

export type WeekStripDay = {
  day: string;
  /** 当天排了多少分钟 */
  minutes: number;
  /** 当天完成了几项、共几项 */
  done: number;
  total: number;
  isToday: boolean;
};

export type WeekStripProps = {
  days: WeekStripDay[];
  selected: string;
  onSelect: (day: string) => void;
  /** 负载条的满格基准（分钟）。默认 120——一个晚上的合理上限 */
  fullAt?: number;
};

export function WeekStrip({ days, selected, onSelect, fullAt = 120 }: WeekStripProps) {
  const t = useTokens();

  return (
    <View style={styles.row}>
      {days.map((d) => {
        const active = d.day === selected;
        const pct = Math.min(1, d.minutes / fullAt);
        const allDone = d.total > 0 && d.done === d.total;

        return (
          <Pressable
            key={d.day}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${dayOfMonth(d.day)} 日，${d.total} 项任务${d.isToday ? '，今天' : ''}`}
            onPress={() => onSelect(d.day)}
            style={({ pressed }) => [
              styles.cell,
              active ? { backgroundColor: t.primarySoft } : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <AppText variant="caption" tone={active ? 'primary' : 'textFaint'}>
              {weekdayShort(d.day)}
            </AppText>

            <AppText variant="subtitle" tone={active || d.isToday ? 'primary' : 'textMuted'}>
              {dayOfMonth(d.day)}
            </AppText>

            <View style={[styles.track, { backgroundColor: t.surfaceSelected }]}>
              {d.minutes > 0 ? (
                <View
                  style={{
                    // 负载条宽度用百分比：格宽是 flex 撑出来的，拿不到像素值
                    width: `${Math.round(pct * 100)}%` as `${number}%`,
                    height: '100%',
                    backgroundColor: allDone ? t.success : t.primary,
                    opacity: active ? 1 : 0.75,
                  }}
                />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: space.xs,
  },
  cell: {
    flex: 1,
    minHeight: touchTarget + 22,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xxs,
  },
  pressed: {
    opacity: 0.6,
  },
  track: {
    width: '72%',
    height: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
    marginTop: space.xxs,
  },
});
