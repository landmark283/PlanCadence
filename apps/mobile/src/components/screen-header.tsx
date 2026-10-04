/**
 * 页面顶部栏。
 *
 * 四屏共用，因此标题的字号、与副标题的间距、安全区处理只有一种写法。
 * 用 `alignItems: 'flex-end'` 让右侧动作与标题**基线对齐**——
 * 居中对齐会让「全部拒绝」这类文字动作浮在半空，和标题断开关系。
 */
import { StyleSheet, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { screenPadding, space, touchTarget } from '@/theme';

export type ScreenHeaderProps = {
  title: string;
  /** 副标题：日期、版本号这类上下文 */
  meta?: string;
  /** 右侧动作。只放次级/文字动作，主要操作一律留给底部操作栏 */
  right?: React.ReactNode;
  /** 顶部额外留白。默认 space.sm；需要呼吸感的页面（如访谈流）可以调大 */
  topGap?: number;
  style?: ViewProps['style'];
};

export function ScreenHeader({ title, meta, right, topGap = space.sm, style }: ScreenHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + topGap }, style]}>
      <View style={styles.row}>
        <View style={styles.titleBox}>
          <AppText variant="display">{title}</AppText>
          {meta ? (
            <AppText variant="label" tone="textFaint">
              {meta}
            </AppText>
          ) : null}
        </View>
        {right}
      </View>
    </View>
  );
}

/**
 * 顶部的文字动作。
 *
 * 排版和颜色仍然走 `AppText` 的 label 变体（不在这里写死 fontSize/color，
 * 否则就多了一个真相源），这里的样式只负责把触控区撑到 44。
 */
export function HeaderAction({
  label,
  onPress,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <AppText
      variant="label"
      tone="textMuted"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      suppressHighlighting
      style={styles.action}
    >
      {label}
    </AppText>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: screenPadding,
    paddingBottom: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.md,
  },
  titleBox: {
    flex: 1,
  },
  action: {
    minHeight: touchTarget,
    paddingVertical: space.md,
    textAlignVertical: 'center',
  },
});
