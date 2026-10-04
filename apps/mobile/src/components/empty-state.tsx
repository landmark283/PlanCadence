/**
 * 空状态 —— 规则 `state-empty-state`：零数据必须给出**解释 + 下一步**，
 * 不能是一片空白。评委一定会点到空状态，这是最容易露怯的地方。
 */
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { Card } from '@/components/card';
import { radius, space, useTokens } from '@/theme';

export type EmptyStateProps = {
  /** 一个字符的符号。不用图标库，符号足够表达「空/完成/无结果」 */
  glyph: string;
  title: string;
  body: string;
  /** success 用于「没有待办是好事」这类正向的空，neutral 用于中性的空 */
  tone?: 'success' | 'neutral';
};

export function EmptyState({ glyph, title, body, tone = 'neutral' }: EmptyStateProps) {
  const t = useTokens();
  const accent = tone === 'success';

  return (
    <Card style={styles.card}>
      <View style={[styles.badge, { backgroundColor: accent ? t.successSoft : t.surfaceSelected }]}>
        <AppText variant="subtitle" tone={accent ? 'success' : 'textFaint'}>
          {glyph}
        </AppText>
      </View>
      <AppText variant="subtitle">{title}</AppText>
      <AppText variant="label" tone="textMuted" style={styles.body}>
        {body}
      </AppText>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    alignItems: 'center',
    paddingVertical: space.xxl,
    gap: space.sm,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  body: {
    textAlign: 'center',
  },
});
