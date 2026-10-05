/**
 * 日程格子 —— 周条和月历共用的一格。
 *
 * ## 为什么必须抽出来
 *
 * 「日历的格子和首页周条长得一样」这句话，如果两边各写一遍 JSX，是靠人自觉维持的。
 * 而这个项目已经吃过一次这个亏：任务卡和待排池曾有**两段几乎一样的 15 行 JSX**，
 * 分头演化之后「改了其中一处、另一处忘了改」。
 * 所以这里不是照着周条再画一个月历，周条本身就是用它拼的。
 *
 * ## 负载条的满格基准也在这里
 *
 * `LOAD_FULL_AT` 比配色更要紧：两个视图如果对「多重算满」理解不同，
 * 同一个学生在同一天会看到两种长度，而**长度是这一屏唯一的信息载体**
 * （颜色已经被状态占用了，再来一套颜色编码，学生就得同时维护两张对照表）。
 *
 * ## 尺寸不在这里定死
 *
 * 周条的格子是 66 高（要放下「周几 / 日号 / 负载条」三行），
 * 月历的格子是 48 高（周几那一行由列头承担，省下来）。所以 `minHeight`
 * 由调用方通过 `style` 覆盖，这里只管**内容和配色的那部分一致**。
 */
import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';

import { AppText } from '@/components/app-text';
import { dayOfMonth, weekdayShort } from '@/lib/dates';
import { radius, space, useTokens } from '@/theme';

/** 负载条的满格基准（分钟）。默认 120——一个晚上的合理上限 */
export const LOAD_FULL_AT = 120;

export type DayLoad = {
  day: string;
  /** 当天排了多少分钟 */
  minutes: number;
  /** 当天完成了几项、共几项 */
  done: number;
  total: number;
  isToday: boolean;
};

export type DayCellProps = {
  load: DayLoad;
  /** 选中态：浅色底 + 主色数字 */
  selected: boolean;
  /** 显示「周几」小字。周条上是 true（一行七天要靠它认），月历上是 false（列头已经有） */
  showWeekday?: boolean;
  /** 不在当前月里的补格。压暗但仍可点——那些日子上的任务是真的 */
  muted?: boolean;
  /** 满格基准。默认 120；周条和月历必须传同一个值 */
  fullAt?: number;
  onPress: () => void;
  style?: ViewProps['style'];
};

export function DayCell({
  load,
  selected,
  showWeekday = false,
  muted = false,
  fullAt = LOAD_FULL_AT,
  onPress,
  style,
}: DayCellProps) {
  const t = useTokens();
  const pct = Math.min(1, fullAt > 0 ? load.minutes / fullAt : 0);
  const allDone = load.total > 0 && load.done === load.total;

  /**
   * 无障碍标签。**它也是自动化验证定位格子的依据**
   * （`.dev/shot.mjs` 按 `aria-label*=" 项任务"` 找格子来量尺寸），
   * 所以改这句话要顺手改那边。
   */
  const label = `${dayOfMonth(load.day)} 日，${load.total} 项任务${load.isToday ? '，今天' : ''}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.cell,
        selected ? { backgroundColor: t.primarySoft } : null,
        pressed ? styles.pressed : null,
        style,
      ]}
    >
      {showWeekday ? (
        <AppText variant="caption" tone={selected && !muted ? 'primary' : 'textFaint'}>
          {weekdayShort(load.day)}
        </AppText>
      ) : null}

      <AppText variant="subtitle" tone={muted ? 'textFaint' : selected || load.isToday ? 'primary' : 'textMuted'}>
        {dayOfMonth(load.day)}
      </AppText>

      <View style={[styles.track, { backgroundColor: t.surfaceSelected }]}>
        {load.minutes > 0 ? (
          <View
            style={{
              // 负载条宽度用百分比：格宽是 flex 撑出来的，拿不到像素值
              width: `${Math.round(pct * 100)}%` as `${number}%`,
              height: '100%',
              backgroundColor: allDone ? t.success : t.primary,
              opacity: muted ? 0.4 : selected ? 1 : 0.75,
            }}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cell: {
    flex: 1,
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
