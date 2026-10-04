/**
 * 卡片 —— 全应用唯一的容器原语。
 *
 * 抽出来的理由：四屏共用同一个圆角 / 内边距 / 内部间距之后，
 * 「整体视觉风格一致」就不再依赖人自觉，而是没有第二种写法可选。
 * 之前只有一屏时这些值是散落在各处的字面量。
 *
 * 层级用**色调**表达（surface / raised / sunken / accent），不用阴影：
 * 深色模式下阴影几乎不可见，堆多了还显脏。
 */
import { StyleSheet, View, type StyleProp, type TextStyle, type ViewProps } from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, space, type Tokens, useTokens } from '@/theme';

export type CardTone =
  /** 默认卡片 */
  | 'surface'
  /** 抬升面：需要从同级卡片里跳出来时用 */
  | 'raised'
  /** 下沉面：被拒绝 / 已完成等「退后」的状态 */
  | 'sunken'
  /** 主色容器：一屏最多出现一次，用于真正的焦点 */
  | 'accent';

export type CardProps = ViewProps & {
  tone?: CardTone;
  /** 只在色调层级不足以区分时才描边（规则 `hier-replace-borders-with-space`） */
  bordered?: boolean;
};

const TONES: Record<CardTone, { bg: keyof Tokens; border: keyof Tokens }> = {
  surface: { bg: 'surface', border: 'border' },
  raised: { bg: 'surfaceRaised', border: 'border' },
  sunken: { bg: 'surfaceSunken', border: 'border' },
  accent: { bg: 'primarySoft', border: 'primaryBorder' },
};

export function Card({ tone = 'surface', bordered = false, style, ...rest }: CardProps) {
  const t = useTokens();
  const m = TONES[tone];
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: t[m.bg] },
        bordered ? { borderWidth: 1, borderColor: t[m.border] } : null,
        style,
      ]}
      {...rest}
    />
  );
}

/**
 * 区块小标题。
 *
 * 字号小、颜色淡、字距微开——规则 `hier-values-over-labels`：
 * 标签是给内容当注脚的，不该和内容抢注意力。
 */
export function SectionLabel({ children, style }: { children: React.ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <AppText variant="label" tone="textFaint" style={[styles.sectionLabel, style]}>
      {children}
    </AppText>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.sm,
  },
  sectionLabel: {
    letterSpacing: 0.4,
  },
});
