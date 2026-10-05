/**
 * 目标卡片 —— 一条线一张卡。
 *
 * ## 一屏一焦点，所以这一屏的焦点是「哪条线要紧」
 *
 * 卡片的视觉层级刻意压平：标题 + 状态胶囊 + 进度条 + 一行人话。
 * 主色只出现在**风险**那一处（`来不及` 的胶囊和进度条的 warning 色调），
 * 因为学生打开这一屏就是要看「有没有哪条线要出事」。全绿的屏上没有任何强调色，
 * 这本身就是信息。
 *
 * ## 为什么整块内容区可点
 *
 * 和任务卡同一个模式：**整块内容区 = 展开/收起**，展开后才是判据、能力点、
 * 排期区间这些细节。理由也一样——那个 26×22 的浅色小字的教训
 * （见 `docs/版本更新.md` v0.3）：看起来不像能点的东西，学生就当作是坏的。
 *
 * 「编辑这一项」那条入口在展开区里，因为长按对读屏用户完全不可见，
 * 一个只有长按的入口等于没有入口。目标的编辑目前只做**挪截止日**
 * （那是复盘卡片已经在做的事），所以这里不做编辑入口——**没有动作就不放按钮**，
 * 放一个点了没反应的胶囊比不放更坏。
 */
import { Pressable, StyleSheet, View } from 'react-native';
import type { GoalProgress } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { Chip } from '@/components/chip';
import { Collapsible } from '@/components/collapsible';
import { ProgressBar } from '@/components/progress-bar';
import { fmtMinutes, fmtMonthDay } from '@/lib/dates';
import { space, touchTarget, useTokens } from '@/theme';
/** 状态胶囊：只有「已完成」是好事，所以只有它用 success 填充 */
const STATUS: Record<GoalProgress['status'], { text: string; tone: 'neutral' | 'success' | 'warning' }> = {
  pending: { text: '还没开始', tone: 'neutral' },
  // 「进行中」走中性描边，**不用主色**：这一屏的主色已经给了进度条，
  // 而一屏一个强调色是硬规则（`color-limit-accents`）。状态是事实，不是焦点。
  active: { text: '进行中', tone: 'neutral' },
  done: { text: '已完成', tone: 'success' },
  dropped: { text: '不做了', tone: 'neutral' },
};

function deadlineText(g: GoalProgress): string {
  if (!g.due) return '没有截止日';
  if (g.daysLeft === null) return `截止 ${fmtMonthDay(g.due)}`;
  if (g.daysLeft < 0) return `${fmtMonthDay(g.due)} · 已过期 ${-g.daysLeft} 天`;
  if (g.daysLeft === 0) return `${fmtMonthDay(g.due)} · 今天截止`;
  return `${fmtMonthDay(g.due)} · 还剩 ${g.daysLeft} 天`;
}

export function GoalCard({
  goal,
  expanded,
  onToggle,
}: {
  goal: GoalProgress;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTokens();
  const status = STATUS[goal.status];
  const pct = goal.totalTasks ? goal.doneTasks / goal.totalTasks : 0;
  const settled = goal.status === 'done' || goal.status === 'dropped';

  /** 第二行：项数 / 已投入 / 剩余。没有任务时不摆一串 0 */
  const numbers: string[] = [];
  if (goal.totalTasks) {
    numbers.push(`${goal.doneTasks}/${goal.totalTasks} 项`);
    if (goal.spentMin > 0) numbers.push(`已投入 ${fmtMinutes(goal.spentMin)}`);
    if (goal.remainingMin > 0) numbers.push(`还剩 ${fmtMinutes(goal.remainingMin)}`);
  }

  const range =
    goal.firstScheduled && goal.lastScheduled
      ? goal.firstScheduled === goal.lastScheduled
        ? fmtMonthDay(goal.firstScheduled)
        : `${fmtMonthDay(goal.firstScheduled)} – ${fmtMonthDay(goal.lastScheduled)}`
      : null;

  /**
   * 「排期」这一行。
   *
   * 只说区间会骗人：两项任务只有一项排上时，「排期 10月25日」读起来像排好了。
   * 所以只要还有任务悬在待排池，就把这件事一并说出来——这是学生唯一
   * 能看见它的地方（待排池里那几项没标属于哪条线）。
   */
  const scheduleText = range
    ? goal.unscheduledTasks
      ? `${range} · 还有 ${goal.unscheduledTasks} 项在待排池`
      : range
    : goal.totalTasks
      ? `还没排进任何一天${goal.unscheduledTasks ? `（${goal.unscheduledTasks} 项都在待排池）` : ''}`
      : null;

  return (
    <Card bordered tone={settled ? 'sunken' : 'surface'} style={styles.card}>
      {/* 整块内容区就是展开键。胶囊是它的**兄弟**，不能嵌在里面——
          Pressable 套 Pressable 在 web 上会冒泡、在原生上靠 responder，两边不一致 */}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={`${goal.title}，${status.text}${goal.atRisk ? '，可能来不及' : ''}，点开看细节`}
        onPress={onToggle}
        style={({ pressed }) => [styles.head, pressed ? styles.pressed : null]}
      >
        <View style={styles.headTop}>
          <AppText variant="subtitle" style={styles.title} numberOfLines={2}>
            {goal.title}
          </AppText>
          <AppText variant="caption" tone="textFaint" style={styles.caret}>
            {expanded ? '⌃' : '⌄'}
          </AppText>
        </View>

        <View style={styles.chipRow}>
          <Chip tone={status.tone}>{status.text}</Chip>
          {/* 风险用 warning 填充：这一屏唯一的语义色，全绿的屏本身就是好消息 */}
          {goal.atRisk ? (
            <Chip tone="warning">
              来不及{goal.shortfallMin !== null ? ` · 差 ${fmtMinutes(goal.shortfallMin)}` : ''}
            </Chip>
          ) : null}
          {goal.overdue && !goal.atRisk ? <Chip tone="warning">已过期</Chip> : null}
        </View>

        <AppText variant="label" tone={goal.overdue ? 'warning' : 'textMuted'}>
          {deadlineText(goal)}
        </AppText>

        {goal.totalTasks ? (
          <View style={styles.progressBlock}>
            <ProgressBar value={pct} tone={goal.atRisk || goal.overdue ? 'warning' : settled ? 'success' : 'primary'} />
            <AppText variant="caption" tone="textFaint">
              {numbers.join(' · ')}
            </AppText>
          </View>
        ) : (
          <AppText variant="caption" tone="textFaint">
            这条线还没有具体任务
          </AppText>
        )}
      </Pressable>

      <Collapsible open={expanded}>
        <View style={[styles.detail, { borderTopColor: t.border }]}>
          {/* 三个小节的标签样式统一（caption + textFaint），值统一 label + textMuted。
              「排期」原来走的是另一套（和「能力点」一样的 label 行），
              结果读出来是「排期  排期 10月7日–10月26日」——标签的词被值重复了一遍 */}
          {scheduleText ? <Block label="排期">{scheduleText}</Block> : null}

          {goal.competences.length ? (
            <View style={styles.block}>
              <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
                能力点
              </AppText>
              {goal.competences.map((c) => (
                <View key={c.id} style={styles.row}>
                  <AppText variant="label" tone="textMuted" style={styles.rowName}>
                    {c.name}
                  </AppText>
                  {/*
                    没有证据时不显示百分数。`current` 对新目标是 0，而「0%」读起来
                    像一个评价——系统其实只是还不知道。这句话必须老实说。
                  */}
                  <AppText variant="label" tone={c.hasEvidence ? 'textMuted' : 'textFaint'}>
                    {c.hasEvidence ? `${Math.round(c.current * 100)}% / 目标 ${Math.round(c.target * 100)}%` : '还没有证据'}
                  </AppText>
                </View>
              ))}
            </View>
          ) : null}

          {goal.criteria.length ? (
            <View style={styles.block}>
              <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
                达成判据
              </AppText>
              {goal.criteria.map((c, i) => (
                <AppText key={`c${i}`} variant="label" tone="textMuted">
                  · {c}
                </AppText>
              ))}
            </View>
          ) : null}

          {!goal.competences.length && !goal.criteria.length && !scheduleText ? (
            <AppText variant="label" tone="textFaint">
              这条线还没有判据和任务，可以在「跟 AI 说说」里补一句。
            </AppText>
          ) : null}
        </View>
      </Collapsible>
    </Card>
  );
}

/** 展开区里的一小节：小标签 + 一行值 */
function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <AppText variant="caption" tone="textFaint" style={styles.eyebrow}>
        {label}
      </AppText>
      <AppText variant="label" tone="textMuted">
        {children}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 0,
  },
  head: {
    // 44 是触控区下限；这一块远高于它，但留一条硬下限以免以后被压扁
    minHeight: touchTarget,
    gap: space.sm,
  },
  headTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  title: {
    flex: 1,
  },
  caret: {
    // 只是提示，触控由整块内容区承担
    paddingTop: space.xs,
  },
  pressed: {
    opacity: 0.6,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
  },
  progressBlock: {
    gap: space.xs,
  },
  detail: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.md,
  },
  block: {
    gap: space.xs,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: space.md,
  },
  rowName: {
    flexShrink: 1,
  },
  eyebrow: {
    letterSpacing: 0.4,
  },
});
