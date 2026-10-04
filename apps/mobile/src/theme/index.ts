/**
 * 主题入口。
 *
 * 与模板原来的实现有两处不同：
 *  1. 令牌是**完整的语义集**（surface 阶梯、语义色、软背景），不只有 5 个颜色。
 *  2. `useColorScheme()` 在系统无偏好时返回 `null`——模板检查的是 `'unspecified'`，
 *     永远为假，于是 `Colors[null]` 会是 undefined。这里按 null 兜底到浅色。
 */
import { useColorScheme } from '@/hooks/use-color-scheme';
import { themes, type Tokens } from './tokens';

/** 当前配色方案。`useColorScheme()` 在系统无偏好时返回 null，这里兜底到浅色 */
export function useScheme(): 'light' | 'dark' {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

export function useTokens(): Tokens {
  return themes[useScheme()];
}

export * from './tokens';
