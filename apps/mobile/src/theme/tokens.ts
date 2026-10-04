/**
 * 设计令牌 —— 平台中立的自有语言。
 *
 * 三条来自 design-review 技能的硬规则，直接决定了这里的结构：
 *
 *  1. `color-hsl-scales`：色相定义为 HSL 阶梯，变体只改亮度。
 *     所以下面每个色相是一整条 ramp，而不是散落的一次性色值。
 *  2. `color-limit-accents`：一个强调色 + 中性灰。主色只用于「当前状态」和
 *     「主要操作」，其余一律中性——到处用主色是最典型的 AI 味来源。
 *  3. `color-avoid-pure-black`：深色背景用近黑（`gray[950]`），不用 `#000`。
 *     纯黑在 OLED 上对比过硬，也让层级无处安放。
 *
 * 层级刻意**不用阴影**表达，而用「色调表面」（surface → surfaceRaised）。
 * 这是 Material 3 最值得借的一条：深色模式下尤其干净。
 */

/* ------------------------------------------------------------------ *
 * 调色板（HSL ramp）
 * ------------------------------------------------------------------ */

export const palette = {
  /** 略带蓝的冷灰。纯灰发脏，冷灰更有质感 */
  gray: {
    0: 'hsl(220 24% 99%)',
    50: 'hsl(220 22% 97%)',
    100: 'hsl(220 18% 94%)',
    200: 'hsl(220 15% 88%)',
    300: 'hsl(220 13% 78%)',
    400: 'hsl(220 11% 62%)',
    500: 'hsl(220 10% 50%)',
    600: 'hsl(220 12% 40%)',
    700: 'hsl(220 14% 30%)',
    800: 'hsl(220 16% 22%)',
    850: 'hsl(220 18% 17%)',
    900: 'hsl(222 20% 12%)',
    950: 'hsl(224 24% 7%)',
    975: 'hsl(224 26% 4%)',
  },
  /** 唯一强调色。靛蓝：冷静、学生熟悉、不刺眼 */
  brand: {
    100: 'hsl(243 70% 94%)',
    200: 'hsl(243 72% 88%)',
    300: 'hsl(243 74% 80%)',
    400: 'hsl(243 74% 71%)',
    500: 'hsl(243 72% 64%)',
    600: 'hsl(243 66% 56%)',
    700: 'hsl(243 62% 48%)',
    800: 'hsl(243 55% 40%)',
    900: 'hsl(243 45% 30%)',
    950: 'hsl(243 40% 18%)',
  },
  /** 语义色。每个都必须在深浅两种模式下都达到正文对比度 */
  green: { 400: 'hsl(158 64% 52%)', 600: 'hsl(158 70% 38%)' },
  amber: { 400: 'hsl(38 92% 60%)', 600: 'hsl(32 88% 46%)' },
  red: { 400: 'hsl(2 84% 68%)', 600: 'hsl(2 72% 52%)' },
} as const;

/* ------------------------------------------------------------------ *
 * 语义令牌
 * ------------------------------------------------------------------ */

export type Tokens = {
  /** 页面底色 */
  bg: string;
  /** 卡片/面板 */
  surface: string;
  /** 抬升面：比 surface 更亮/更暗一档，用于强调块或嵌套容器 */
  surfaceRaised: string;
  /** 下沉面：用于输入框凹槽、代码块 */
  surfaceSunken: string;
  /** 选中态表面 */
  surfaceSelected: string;
  /** 分隔线。规则要求「优先用空间分组」，所以它只用在真正必要处 */
  border: string;
  borderStrong: string;

  text: string;
  textMuted: string;
  textFaint: string;

  primary: string;
  /** 主色之上的文字/图标色 */
  onPrimary: string;
  /** 主色的低饱和容器色，用于选中/高亮背景 */
  primarySoft: string;
  primaryBorder: string;

  success: string;
  warning: string;
  danger: string;
  /** 语义色的低饱和容器 */
  successSoft: string;
  warningSoft: string;
  dangerSoft: string;
};

export const themes: Record<'light' | 'dark', Tokens> = {
  dark: {
    bg: palette.gray[975],
    surface: palette.gray[900],
    surfaceRaised: palette.gray[850],
    surfaceSunken: 'hsl(224 26% 3%)',
    surfaceSelected: palette.gray[800],
    border: 'hsl(220 14% 19%)',
    borderStrong: 'hsl(220 13% 26%)',

    text: palette.gray[100],
    textMuted: palette.gray[400],
    textFaint: palette.gray[500],

    primary: palette.brand[500],
    onPrimary: palette.gray[975],
    primarySoft: palette.brand[950],
    primaryBorder: palette.brand[800],

    success: palette.green[400],
    warning: palette.amber[400],
    danger: palette.red[400],
    successSoft: 'hsl(158 40% 14%)',
    warningSoft: 'hsl(38 45% 15%)',
    dangerSoft: 'hsl(2 40% 16%)',
  },
  light: {
    // 页面底色刻意比卡片暗一档：卡片靠「更亮」浮起来，而不是靠描边。
    // 原来 97% vs 99% 几乎分不开，只能靠 border 硬撑，正是
    // `hier-replace-borders-with-space` 要避免的。
    bg: palette.gray[100],
    surface: palette.gray[0],
    surfaceRaised: palette.gray[50],
    surfaceSunken: palette.gray[100],
    surfaceSelected: palette.gray[200],
    border: 'hsl(220 16% 89%)',
    borderStrong: 'hsl(220 15% 80%)',

    text: 'hsl(222 30% 12%)',
    // 浅色下把这两级压暗一档：原来的 62% 灰落在 94% 底色上只有约 3.2:1，
    // 达不到正文要求的 4.5:1（`color-meet-contrast`）。
    textMuted: palette.gray[600],
    textFaint: palette.gray[500],

    primary: palette.brand[600],
    onPrimary: palette.gray[0],
    primarySoft: palette.brand[100],
    primaryBorder: palette.brand[200],

    success: palette.green[600],
    warning: palette.amber[600],
    danger: palette.red[600],
    successSoft: 'hsl(158 60% 94%)',
    warningSoft: 'hsl(38 90% 93%)',
    dangerSoft: 'hsl(2 80% 95%)',
  },
};

/* ------------------------------------------------------------------ *
 * 间距
 * ------------------------------------------------------------------ */

/** 4 的倍数阶梯。规则 `space-use-a-scale`：所有间距必须来自同一个阶梯 */
export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
  huge: 64,
} as const;

/** 屏幕左右统一内边距。规则 `space-start-generous`：宁可比感觉更宽一点 */
export const screenPadding = space.xl;

/* ------------------------------------------------------------------ *
 * 形状
 * ------------------------------------------------------------------ */

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
  pill: 999,
} as const;

/* ------------------------------------------------------------------ *
 * 排版
 * ------------------------------------------------------------------ *
 * 规则 `type-line-height-by-size`：字号越大行高比例越小。
 * 中文没有西文那样的升降部，行高比西文再放宽 0.05–0.1 才不挤。
 */
export const type = {
  /** 页面主标题 */
  display: { fontSize: 30, lineHeight: 36, fontWeight: '700' },
  /** 区块/卡片标题 */
  title: { fontSize: 20, lineHeight: 28, fontWeight: '600' },
  /** 小标题 */
  subtitle: { fontSize: 16, lineHeight: 24, fontWeight: '600' },
  /** 正文。规则 `type-readable-body-size`：正文不能为了塞内容而缩小 */
  body: { fontSize: 15, lineHeight: 25, fontWeight: '400' },
  /** 辅助信息 */
  label: { fontSize: 13, lineHeight: 19, fontWeight: '500' },
  /** 极小号：时间戳、序号 */
  caption: { fontSize: 11, lineHeight: 16, fontWeight: '500' },
  /** 数字：用等宽避免跳动 */
  numeric: { fontSize: 26, lineHeight: 32, fontWeight: '700' },
} as const;

export type TypeVariant = keyof typeof type;

/* ------------------------------------------------------------------ *
 * 动效
 * ------------------------------------------------------------------ *
 * 规则 `motion-under-300ms` + `motion-ease-out-custom`：
 * 全部 < 300ms，用同一个强 ease-out 曲线。
 *
 * **优先只动 transform 与 opacity**，但这条不是绝对的。有两处必须改布局，
 * 都是有意为之，各自在文件里写了理由：
 *   · 展开面板的高度（`components/collapsible.tsx`）——高度没有替代方案，
 *     用 scaleY 会把里面的文字压扁
 *   · 计数文字（`hooks/use-count-up.ts`）——变的是文字内容，
 *     只动 transform 就得做成每位数字一条竖列的里程表
 * 除此之外新加动效都应该能只靠 transform / opacity 完成。
 */
export const motion = {
  fast: 150,
  base: 220,
  slow: 280,
} as const;

/** cubic-bezier(0.23, 1, 0.32, 1) —— Emil Kowalski 的 UI 标准出曲线。
 *  用 `lib/motion.ts` 的 `easingOut` 取用，别在组件里重新拼 */
export const easeOut = [0.23, 1, 0.32, 1] as const;

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

/** 规则 `resp-touch-target-size`：任何可点元素都不能小于 44 */
export const touchTarget = 44;

export const layout = {
  maxContentWidth: 560,
  tabBarHeight: 58,
} as const;
