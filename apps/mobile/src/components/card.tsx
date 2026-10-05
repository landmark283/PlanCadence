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
import { Pressable, StyleSheet, View, type StyleProp, type TextStyle, type ViewProps } from 'react-native';

import { AppText } from '@/components/app-text';
import { Chip, type ChipTone } from '@/components/chip';
import { radius, space, touchTarget, type Tokens, useTokens } from '@/theme';

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

/**
 * 带动作的区块标题：左边是标签，右边是这个区块的动作（「日历」「+ 新任务」）。
 *
 * 存在的理由和 `Card` 一样：不加这一层，每个区块都会自己拼一个
 * 「左边文字 + 右边按钮」的行，然后行高、对齐、触控区各写一遍。
 */
export function SectionHeader({
  children,
  right,
  style,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  style?: ViewProps['style'];
}) {
  return (
    <View style={[styles.sectionHeader, style]}>
      <SectionLabel style={styles.sectionHeaderLabel}>{children}</SectionLabel>
      {right}
    </View>
  );
}

/**
 * 区块标题上的动作。
 *
 * ## 为什么外面要套一层 44pt 的 Pressable
 *
 * 这是这个项目已经吃过一次的亏：任务卡上那个「调整」是**一个 26×22 的浅色小字**，
 * 触控区只有 26×22，`hitSlop` 在原生上还会被父视图边界裁掉，
 * 于是它看起来像注脚而不像按钮，学生按了觉得「没反应」。
 *
 * 胶囊自己 30pt 高、`hitSlop` 只有 6（合计 42，差一点点），
 * 所以**动作位的外层必须自己撑到 44**。把这件事收进一个组件之后，
 * 每个调用点就不需要重新记得它——这正是当初那个按钮失效的机制。
 * 三处都在用它：区块标题上的「日历」、月历的翻月与「回到今天」、
 * 任务卡展开区里的「编辑这一项」。
 */
export function ChipAction({
  label,
  tone = 'neutral',
  selected = false,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  tone?: ChipTone;
  selected?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chipAction, pressed ? styles.pressed : null]}
    >
      <Chip tone={tone} selected={selected}>
        {label}
      </Chip>
    </Pressable>
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
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    // 动作位要 44，标题行跟着长高——不然 hitSlop 会被这行的边界裁掉
    minHeight: touchTarget,
  },
  sectionHeaderLabel: {
    flex: 1,
  },
  chipAction: {
    minHeight: touchTarget,
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
