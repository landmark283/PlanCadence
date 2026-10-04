/**
 * 任务卡 —— 今日页的主体，学生待最久的组件。
 *
 * 设计取舍：
 *  1. **默认折叠，点「调整」展开**。一张卡上同时摆 5 个状态按钮 + 6 个时长档位，
 *     一屏就是一片按钮墙。折叠态只留「是什么 + 多重 + 什么状态」，
 *     需要改的时候再展开。
 *  2. **元信息胶囊不可点**。让它们可点会和「整块标题区展开」抢同一个手势，
 *     嵌套 Pressable 的行为在 Web 和原生上还不一致。改状态/改时长统一在展开区。
 *  3. **完成只走勾选框**。状态选择器里刻意没有「已完成」，避免两个入口改同一个字段。
 *
 * ## 划掉是怎么做的（这段别随手改）
 *
 * 划过文字的那条线**不是**画上去的，而是**第二份一模一样的文字**，只是
 * `color: transparent` 而 `textDecorationColor` 用真实颜色——于是只有线可见。
 * 再把这个副本整体淡入。
 *
 * 为什么不直接画一条 line：标题经常折成两行，而按容器宽度画的线会一直伸到
 * 第二行末尾的空白处。真正按行精确的线只有文字自己的装饰线能给。
 * 也不去量文字——`onTextLayout` 在 react-native-web 上是空的，
 * 而截图和端到端脚本都跑在 web 上，量出来的东西在两边会不一致。
 *
 * 副本必须对读屏隐藏，否则一句话会被念两遍。
 */
import { useEffect, useRef } from 'react';
import { Animated, Linking, Pressable, StyleSheet, View } from 'react-native';
import type { Resource, Task, TaskStatus } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { CheckControl } from '@/components/check-control';
import { Chip } from '@/components/chip';
import { Collapsible } from '@/components/collapsible';
import { fmtMinutes, fmtMonthDay } from '@/lib/dates';
import { easingOut } from '@/lib/motion';
import { ESTIMATE_PRESETS, SELECTABLE_STATUSES, STATUS_LABEL, STATUS_TONE, TYPE_LABEL } from '@/lib/task-meta';
import { motion, space, touchTarget, useTokens } from '@/theme';

export type TaskCardProps = {
  task: Task;
  /** 前置任务及其完成情况。用来回答「为什么这项还不能做」 */
  deps: { id: string; title: string; done: boolean }[];
  /**
   * 这条任务挂着的资料。
   *
   * 工具调用（§8）查回来的东西如果不显示在这里，学生看到的就只是资源面板里
   * 一列和任务对不上号的链接——「系统主动去查了，而且知道这条该配什么」
   * 这件事必须在任务卡上看见才算数。
   */
  resources?: Resource[];
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleDone: () => void;
  onSetStatus: (status: TaskStatus) => void;
  onSetEstimate: (min: number) => void;
  /**
   * 记录实际用时。
   *
   * 这是**自适应引擎唯一的输入**：`detectDrift` 里 overrun / underrun 都要求
   * `status === 'done' && actualMin != null`。界面不打勾报时，引擎就永远
   * 只会说"本期没有发现偏差"——「自适应」也就成了一句空话。
   */
  onSetActual: (min: number) => void;
  /** 待排池里的任务用下沉面，与已排期的区分开 */
  variant?: 'scheduled' | 'backlog';
};

/** 实际耗时超过预估这个倍数时，卡上直接标黄。与 engine.ts 的 OVERRUN_RATIO 同值 */
const OVERRUN_HINT = 1.3;

export function TaskCard({
  task,
  deps,
  resources = [],
  expanded,
  onToggleExpand,
  onToggleDone,
  onSetStatus,
  onSetEstimate,
  onSetActual,
  variant = 'scheduled',
}: TaskCardProps) {
  const t = useTokens();
  const done = task.status === 'done';
  const blockedBy = deps.filter((d) => !d.done);

  /** 0 = 没划掉，1 = 划掉。只驱动划线的淡入淡出 */
  const strike = useRef(new Animated.Value(done ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(strike, {
      toValue: done ? 1 : 0,
      duration: motion.base,
      easing: easingOut,
      useNativeDriver: true,
    }).start();
  }, [done, strike]);

  return (
    <Card tone={variant === 'backlog' ? 'sunken' : 'surface'} bordered>
      <View style={styles.head}>
        <CheckControl
          checked={done}
          accessibilityLabel={done ? `把「${task.title}」标记为未完成` : `把「${task.title}」标记为完成`}
          onToggle={onToggleDone}
        />

        <View style={styles.main}>
          <View style={styles.titleRow}>
            <View style={styles.title}>
              <AppText variant="subtitle" tone={done ? 'textFaint' : 'text'}>
                {task.title}
              </AppText>
              {/* 只有线可见的副本。见文件头「划掉是怎么做的」。
                  只写 `aria-hidden`：RN 自己会把它翻成原生需要的
                  `accessibilityElementsHidden`，而 react-native-web 不认后者、
                  会当成未知属性报警告 */}
              <Animated.View
                pointerEvents="none"
                aria-hidden
                style={[StyleSheet.absoluteFill, { opacity: strike }]}
              >
                <AppText variant="subtitle" style={[styles.strikeOnly, { textDecorationColor: t.textFaint }]}>
                  {task.title}
                </AppText>
              </Animated.View>
            </View>
            {/* 用 Pressable 包一层而不是给 Text 加 hitSlop：RN 0.86 的 TextProps
                里没有 hitSlop，而且把触控区撑到 44 也不该改变文字自身的位置 */}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              accessibilityLabel={expanded ? `收起「${task.title}」的调整` : `调整「${task.title}」`}
              onPress={onToggleExpand}
              hitSlop={space.md}
              style={({ pressed }) => [styles.adjustBtn, pressed ? styles.pressed : null]}
            >
              <AppText variant="label" tone="textFaint">
                {expanded ? '收起' : '调整'}
              </AppText>
            </Pressable>
          </View>

          <View style={styles.metaRow}>
            <Chip tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</Chip>
            <Chip tone="neutral">{TYPE_LABEL[task.type]}</Chip>
            <Chip tone="neutral">{fmtMinutes(task.estimateMin)}</Chip>
            {/* 实际 vs 预估直接摆在卡上：学生一眼能看到自己估得准不准 */}
            {task.actualMin != null ? (
              <Chip tone={task.actualMin / task.estimateMin > OVERRUN_HINT ? 'warning' : 'neutral'}>
                实际 {fmtMinutes(task.actualMin)}
              </Chip>
            ) : null}
            {task.pinned ? <Chip tone="neutral">上锁</Chip> : null}
            {/* 有资料就在折叠态也露一个数字：不然「系统给你配了资料」这件事
                要展开才看得到，等于没发生 */}
            {resources.length > 0 ? (
              <Chip tone="neutral" accessibilityLabel={`这${resources.length} 条资料已挂在任务上`}>
                资料 {resources.length}
              </Chip>
            ) : null}
            {variant === 'backlog' && task.notBefore ? (
              <Chip tone="warning">最早 {fmtMonthDay(task.notBefore)}</Chip>
            ) : null}
          </View>

          {task.notes ? (
            <AppText variant="caption" tone="textFaint" style={styles.notes}>
              {task.notes}
            </AppText>
          ) : null}
        </View>
      </View>

      {blockedBy.length > 0 ? (
        <AppText variant="caption" tone="warning">
          还差前置：{blockedBy.map((d) => d.title).join('、')}
        </AppText>
      ) : null}

      {/* 不用 `expanded ? … : null`：那样收起是瞬间消失，没有动画。
          Collapsible 自己管挂载时机，收起动画播完才卸载 */}
      <Collapsible open={expanded}>
        <View style={[styles.panel, { borderTopColor: t.border }]}>
          <Field label="状态">
            {SELECTABLE_STATUSES.map((s) => (
              <Chip key={s} tone={STATUS_TONE[s]} selected={task.status === s} onPress={() => onSetStatus(s)}>
                {STATUS_LABEL[s]}
              </Chip>
            ))}
          </Field>

          <Field label="预估">
            {ESTIMATE_PRESETS.map((m) => (
              <Chip
                key={m}
                tone="neutral"
                selected={task.estimateMin === m}
                accessibilityLabel={`预估改为 ${m} 分钟`}
                onPress={() => onSetEstimate(m)}
              >
                {m} 分钟
              </Chip>
            ))}
          </Field>

          {/* 只有完成的任务才问实际用时——没做完就谈不上"实际花了多少" */}
          {done ? (
            <Field label="实际">
              {ESTIMATE_PRESETS.map((m) => (
                <Chip
                  key={m}
                  tone="neutral"
                  selected={task.actualMin === m}
                  accessibilityLabel={`实际用时 ${m} 分钟`}
                  onPress={() => onSetActual(m)}
                >
                  {m} 分钟
                </Chip>
              ))}
            </Field>
          ) : null}

          {done && task.actualMin == null ? (
            <AppText variant="caption" tone="textFaint">
              报一下实际用时，系统才知道你的估时是偏松还是偏紧——这是它下次调整排期的依据。
            </AppText>
          ) : null}

          {deps.length > 0 ? (
            <Field label="前置">
              {deps.map((d) => (
                <Chip key={d.id} tone={d.done ? 'success' : 'warning'}>
                  {d.title}
                </Chip>
              ))}
            </Field>
          ) : null}

          {resources.length > 0 ? (
            <Field label="资料">
              {resources.map((r) => (
                <Chip
                  key={r.id}
                  tone="neutral"
                  accessibilityRole="link"
                  accessibilityLabel={`打开资料 ${r.title}`}
                  onPress={() => void Linking.openURL(r.url).catch(() => undefined)}
                >
                  {r.title}
                </Chip>
              ))}
            </Field>
          ) : null}
        </View>
      </Collapsible>
    </Card>
  );
}

/** 展开区里的一行「标签 + 一组胶囊」。标签列定宽，多行才能对齐 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <AppText variant="caption" tone="textFaint" style={styles.fieldLabel}>
        {label}
      </AppText>
      <View style={styles.fieldBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  main: {
    flex: 1,
    gap: space.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  /** 3pt：让 label（行高 19）的基线落到 subtitle（行高 24）的基线上 */
  adjustBtn: {
    paddingTop: 3,
  },
  pressed: {
    opacity: 0.6,
  },
  title: {
    flex: 1,
    /** 副本要绝对定位盖在它上面，所以这一层必须自己撑出高度 */
    position: 'relative',
  },
  /**
   * 划线的副本：文字全透明，只留装饰线。
   * 线色由组件里内联给（要用主题令牌），这里管的是「看不见字」。
   */
  strikeOnly: {
    color: 'transparent',
    textDecorationLine: 'line-through',
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  notes: {
    marginTop: space.xxs,
  },

  /**
   * 展开区。
   *
   * 这里**不能有 marginTop**：Collapsible 量的就是这个盒子的高度，
   * 而 `onLayout` 报的高度不含外边距——留一个 margin，收起时底部会缺一截。
   * 所以 4pt 的间隔并进了 paddingTop。
   */
  panel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.md + space.xs,
    gap: space.md,
  },
  field: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.md,
  },
  fieldLabel: {
    width: 28,
    paddingTop: space.xs + 2,
  },
  fieldBody: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    minHeight: touchTarget - space.md,
    alignItems: 'center',
  },
});
