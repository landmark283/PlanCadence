import { StyleSheet, Text, type TextProps } from 'react-native';

import { type TypeVariant, type Tokens, type as typeScale } from '@/theme';
import { useTokens } from '@/theme';

export type AppTextProps = TextProps & {
  /** 排版级别，取自语义的模块化阶梯（不是随手写 fontSize） */
  variant?: TypeVariant;
  /** 颜色令牌名。默认 text */
  tone?: keyof Tokens;
};

/**
 * 全应用唯一的基础文本组件。
 *
 * 刻意不暴露 `fontSize`/`lineHeight`：规则 `type-modular-scale` 要求字号必须
 * 来自统一的阶梯，随手写一个 17 就会破坏整屏的节奏。需要微调时加一个 variant。
 */
export function AppText({ style, variant = 'body', tone = 'text', ...rest }: AppTextProps) {
  const t = useTokens();
  return <Text style={[typeScale[variant], { color: t[tone] as string }, style]} {...rest} />;
}

/** 模板 demo 页仍在使用的旧名字。新代码请用 AppText */
export const ThemedText = AppText;
export const themedTextStyles = StyleSheet.create({});
