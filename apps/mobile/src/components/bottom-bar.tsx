/**
 * 底部固定操作栏 + 主按钮。
 *
 * 规则 `hier-one-primary-action`：一屏只能有一个主要操作。把它固定在底部，
 * 而不是跟着内容滚——内容再长，学生也知道下一步在哪。
 *
 * 内部容器带 `maxWidth`：平板上内容不会拉成一整条横线；
 * 但**背景条本身铺满全宽**，否则宽屏上会出现一条悬空的色块。
 */
import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { layout, radius, screenPadding, space, useTokens } from '@/theme';

export function BottomBar({
  children,
  bottomInset,
  style,
}: {
  children: React.ReactNode;
  /**
   * 底部额外留白。**不传时取设备安全区**——但位于 tab 导航内的页面必须传 0，
   * 因为底部安全区已经被下方的 tab bar 消费掉了，再加一次就是双份留白。
   */
  bottomInset?: number;
  style?: ViewProps['style'];
}) {
  const t = useTokens();
  const insets = useSafeAreaInsets();
  const pad = bottomInset ?? insets.bottom;

  return (
    <View style={[styles.barOuter, { backgroundColor: t.surface, borderTopColor: t.border }, style]}>
      <View style={[styles.barInner, { paddingBottom: pad + space.md }]}>{children}</View>
    </View>
  );
}

export type PrimaryButtonProps = {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
};

export function PrimaryButton({ label, onPress, disabled = false, accessibilityLabel }: PrimaryButtonProps) {
  const t = useTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryBtn,
        {
          backgroundColor: disabled ? t.surfaceSelected : t.primary,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <AppText variant="subtitle" tone={disabled ? 'textFaint' : 'onPrimary'}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  barOuter: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  barInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingHorizontal: screenPadding,
    paddingTop: space.md,
    maxWidth: layout.maxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  primaryBtn: {
    minHeight: 48,
    paddingHorizontal: space.xxl,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
