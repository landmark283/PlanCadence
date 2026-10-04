import { View, type ViewProps } from 'react-native';

import { type Tokens } from '@/theme';
import { useTokens } from '@/theme';

export type SurfaceProps = ViewProps & {
  /** 表面层级令牌名。默认 bg（页面底色） */
  tone?: keyof Tokens;
};

/**
 * 带色调的基础容器。
 *
 * 层级刻意用「surface → surfaceRaised」表达，不用阴影：
 * 阴影在深色模式下几乎不可见，堆多了还会显脏。
 */
export function Surface({ style, tone = 'bg', ...rest }: SurfaceProps) {
  const t = useTokens();
  return <View style={[{ backgroundColor: t[tone] as string }, style]} {...rest} />;
}
