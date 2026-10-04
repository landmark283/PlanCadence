/**
 * 标签胶囊。
 *
 * 只做「短状态」和「可选项」两类用途，所以刻意不给自由尺寸——
 * 尺寸一自由，一屏里就会出现三种不同高度的胶囊。
 *
 * 可点状态下用 `hitSlop` 把触控区补到 44 以上（规则 `resp-touch-target-size`），
 * 而不是把胶囊本身撑高：视觉上该紧凑的地方，不该为了触控变笨重。
 */
import { Pressable, StyleSheet, View, type ViewProps } from 'react-native';

import { AppText } from '@/components/app-text';
import { radius, space, type Tokens, useTokens } from '@/theme';

export type ChipTone = 'neutral' | 'accent' | 'warning' | 'success' | 'danger';

export type ChipProps = {
  children: React.ReactNode;
  tone?: ChipTone;
  /** 选中态：用主色描边 + 主色文字，不用填充，避免整行都是实心块 */
  selected?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  /**
   * 无障碍角色。默认 `button`。
   *
   * 挂资料的那个胶囊要报成 `link`——读屏用户听到「按钮」会以为点下去
   * 是在这个页面里发生什么，而它其实会跳到浏览器。
   */
  accessibilityRole?: 'button' | 'link';
  style?: ViewProps['style'];
};

const TONES: Record<ChipTone, { bg: keyof Tokens; fg: keyof Tokens }> = {
  neutral: { bg: 'surface', fg: 'textMuted' },
  accent: { bg: 'primarySoft', fg: 'primary' },
  warning: { bg: 'warningSoft', fg: 'warning' },
  success: { bg: 'successSoft', fg: 'success' },
  danger: { bg: 'dangerSoft', fg: 'danger' },
};

export function Chip({
  children,
  tone = 'neutral',
  selected = false,
  onPress,
  accessibilityLabel,
  accessibilityRole = 'button',
  style,
}: ChipProps) {
  const t = useTokens();
  const m = TONES[tone];

  /**
   * 中性胶囊走**描边**而不是填充。
   *
   * 原因是踩过的坑：填充用的是 `surface`，而它经常就摆在同为 `surface` 的卡片上，
   * 于是渲染出来只是几行灰字——访谈页的三个建议项看起来像静态文案，
   * 完全看不出能点。填充色不可能同时在「页面底」和「卡片面」上都成立，
   * 描边可以。
   *
   * 于是形成一条一致的规则：**中性 = 描边，语义色 = 填充，选中 = 主色描边 + 主色浅底**。
   */
  const isNeutral = tone === 'neutral';
  const bg = selected ? t.primarySoft : isNeutral ? 'transparent' : t[m.bg];
  const border = selected ? t.primary : isNeutral ? t.borderStrong : 'transparent';

  const body = (
    <View style={[styles.chip, { backgroundColor: bg, borderColor: border }, style]}>
      <AppText variant="caption" tone={selected ? 'primary' : m.fg}>
        {children}
      </AppText>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
    // 恒为 1：有色胶囊用 transparent 保留同样的盒模型，否则两种胶囊高度会差 2pt
    borderWidth: 1,
  },
  pressed: {
    opacity: 0.6,
  },
});
