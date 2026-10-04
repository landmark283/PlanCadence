/**
 * 资源卡。
 *
 * 两条信息是这张卡存在的理由，都不允许省略：
 *  1. **这条信息是哪来的、什么时候核对的**——证明它不是模型编的。
 *     演示时指着它说一句话，比讲十句「我们接了实时检索」都有用。
 *  2. **赛事截止倒计时**——只对 `kind: 'contest'` 显示。
 *     它依赖 `Resource.deadline` 这个结构化字段，而不是从标题里正则抠日期。
 *
 * ## `verifiedAt` 的意思随来源而变，所以不能只用一种说法
 *
 * 它原本是为「证明信息是刚抓的」设计的，写成「今天校验」没问题。
 * 但内置资料库里的条目**不是刚抓的**——那是人工核对过的固定清单，
 * 如果也显示「今天校验」，就等于把静态数据说成实时数据。
 * 而这一页的说服力恰恰建立在「两者能一眼分清」上，所以按来源分开说：
 *   · 实时抓的  →「今天校验 · 来自 codeforces.com/api」
 *   · 资料库快照 →「资料库快照 · 人工核对于 2026-10-19」
 *   · 其他      → 照旧显示「N 天前校验 · 来自 X」
 */
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { isLiveSource, isSnapshotSource, type Resource } from '@sp/shared';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { Chip } from '@/components/chip';
import { daysBetween } from '@/lib/dates';
import { hostOf, KIND_LABEL } from '@/lib/resource-meta';
import { space } from '@/theme';

/** 快照超过多久算该重新核对了 */
const SNAPSHOT_STALE_DAYS = 180;

/**
 * 这行小字是整张卡的可信度所在，所以按来源分开说，不混成一句。
 *
 * 返回值里 `live` 也会被界面用到：「刚抓的」和「人工核对的」在视觉上要能分开。
 */
export function provenanceLine(
  resource: Resource,
  today: string,
): { text: string; stale: boolean; live: boolean } {
  const source = resource.source;
  const isSnapshot = isSnapshotSource(source);
  const day = resource.verifiedAt?.slice(0, 10);

  if (!resource.verifiedAt) {
    // 没有核对时间的资源没法判断新旧，这本身就是该显示出来的信息
    return { text: source ? `未记录核对时间 · 来自 ${source}` : '未记录核对时间', stale: true, live: false };
  }

  if (isSnapshot) {
    return {
      text: `资料库快照 · 人工核对于 ${day}`,
      stale: daysBetween(day!, today) > SNAPSHOT_STALE_DAYS,
      live: false,
    };
  }

  const age = daysBetween(day!, today);
  const when = age <= 0 ? '今天校验' : age === 1 ? '昨天校验' : `${age} 天前校验`;
  return { text: source ? `${when} · 来自 ${source}` : when, stale: age > 30, live: isLiveSource(source) };
}

function countdown(deadline: string | null, today: string) {
  if (!deadline) return null;
  const left = daysBetween(today, deadline);
  if (left < 0) return { text: `已截止 ${-left} 天`, tone: 'neutral' as const };
  if (left === 0) return { text: '今天截止', tone: 'danger' as const };
  if (left <= 3) return { text: `还有 ${left} 天截止`, tone: 'danger' as const };
  if (left <= 14) return { text: `还有 ${left} 天截止`, tone: 'warning' as const };
  return { text: `还有 ${left} 天截止`, tone: 'accent' as const };
}

export function ResourceCard({ resource, today }: { resource: Resource; today: string }) {
  const prov = provenanceLine(resource, today);
  const left = countdown(resource.deadline, today);
  /**
   * 赛事但没有截止日：**明说为什么没有倒计时**。
   *
   * 这件事原来由 `validatePlan` 报一条计划级警告，现在挪到了这里。理由见
   * `schema.ts` 里第 7 条的注释：工具调用上线后「赛事没有日期」是**正常状态**
   * （蓝桥杯之类的只有官网，我们拒绝编日期），拿它当计划缺陷报警会淹掉真正的提醒。
   * 但学生看到一张没有倒计时的赛事卡确实会疑惑，所以这句话该在这个位置。
   */
  const noDate = resource.kind === 'contest' && !resource.deadline;

  const open = () => {
    // 打不开就算了：这是可选的便利动作，不该让整屏崩掉
    void Linking.openURL(resource.url).catch(() => undefined);
  };

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`打开 ${resource.title}`}
      onPress={open}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      <Card bordered>
        {left || prov.live || noDate ? (
          <View style={styles.topRow}>
            {left ? <Chip tone={left.tone}>{left.text}</Chip> : null}
            {noDate ? <Chip tone="neutral">未记录截止日</Chip> : null}
            {/* 「刚抓的」要在一眼之内认出来，所以给它一个位置而不是藏在注释里 */}
            {prov.live ? <Chip tone="accent">实时</Chip> : null}
          </View>
        ) : null}

        <AppText variant="subtitle">{resource.title}</AppText>

        <View style={styles.metaRow}>
          <Chip tone="neutral">{KIND_LABEL[resource.kind]}</Chip>
          <AppText variant="caption" tone="textFaint">
            {hostOf(resource.url)}
          </AppText>
        </View>

        {/* 来源与新旧。规则 `hier-values-over-labels`：先把结论说完，细节退后 */}
        <AppText variant="caption" tone={prov.stale ? 'warning' : 'textFaint'}>
          {prov.text}
        </AppText>

        {noDate ? (
          <AppText variant="caption" tone="textFaint">
            这个赛事没有可靠的报名/开赛日期，所以不显示倒计时——点开看官网公告。
          </AppText>
        ) : null}
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: {
    opacity: 0.7,
  },
  topRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    flexWrap: 'wrap',
  },
});
