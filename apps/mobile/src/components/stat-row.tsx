/**
 * 数值条 —— 「值在上、标签在下」。
 *
 * 这是规则 `hier-values-over-labels` 最直接的形态：学生关心的是「67%」，
 * 不是「完成率」这个词。所以数字用最大号、标签用最小号且退到下面。
 */
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { space, type Tokens, useTokens } from '@/theme';

export type StatItem = {
  value: string;
  label: string;
  tone?: keyof Tokens;
};

export function StatRow({ items }: { items: StatItem[] }) {
  const t = useTokens();
  return (
    <Card style={styles.card}>
      {items.map((it, i) => (
        <View key={it.label} style={styles.cell}>
          {/* 分隔线用 1px 竖线而不是卡片套卡片：套卡片会多出一层圆角噪音 */}
          {i > 0 ? <View style={[styles.divider, { backgroundColor: t.border }]} /> : null}
          <AppText variant="numeric" tone={it.tone ?? 'text'}>
            {it.value}
          </AppText>
          <AppText variant="caption" tone="textFaint">
            {it.label}
          </AppText>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: space.lg,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    gap: space.xxs,
    justifyContent: 'center',
  },
  divider: {
    position: 'absolute',
    left: 0,
    top: space.xs,
    bottom: space.xs,
    width: StyleSheet.hairlineWidth,
  },
});
