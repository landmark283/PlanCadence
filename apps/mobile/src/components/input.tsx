/**
 * 文本输入框 —— 全应用唯一的输入原语。
 *
 * 抽出来的理由和 `Card` 一样：访谈页和文件页都要输入，两处各写一遍
 * 圆角/内边距/边框/占位色，迟早会有一处忘了改（这个项目里已经发生过：
 * 两段几乎一样的任务卡 JSX 分头演化）。
 *
 * 高度用 `touchTarget`（44）而不是内容撑开——输入框是最不该点不中的控件。
 */
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';

import { radius, space, touchTarget, type as typeScale, useTokens } from '@/theme';

export type InputProps = { multiline?: boolean } & TextInputProps;

export function Input({ multiline = false, ...rest }: InputProps) {
  const t = useTokens();
  return (
    <TextInput
      multiline={multiline}
      placeholderTextColor={t.textFaint}
      style={[
        styles.input,
        typeScale.body,
        {
          color: t.text,
          backgroundColor: t.surfaceSunken,
          borderColor: t.border,
          minHeight: multiline ? 96 : touchTarget,
          textAlignVertical: multiline ? 'top' : 'center',
        },
      ]}
      {...rest}
    />
  );
}

const styles = StyleSheet.create({
  input: {
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
});
