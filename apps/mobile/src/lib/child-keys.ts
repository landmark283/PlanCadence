/**
 * 给「会被当成列表渲染」的子节点补上稳定的 key。
 *
 * ## 为什么需要它（一次真机报错的根因）
 *
 * 手机上出现：`Each child in a list should have a unique "key" prop.
 * Check the render method of RCTView. It was passed a child from TalkScreen.`
 *
 * 追下来是 React Native 的 `ScrollView` 干的：它**无条件**执行
 * `React.Children.toArray(this.props.children)`（`ScrollView.js` 里那句，
 * 就在处理 stickyHeaderIndices 之前）。
 *
 * `React.Children.toArray` / `.map` 的实现在 `react.development.js` 的
 * `mapIntoArray` 里：给一个**没有 key 的元素**克隆出一个新 key 的同时，会把克隆
 * 标成 `_store.validated = 2`（`escapedPrefix._store.validated = 2`）。
 * 而 Fabric 的 `warnForMissingKey` 的触发条件正是：
 *
 *     (!child._store.validated && child.key == null) || child._store.validated === 2
 *
 * 所以「原本没有 key 的直接子节点」在原生上必然报 key 警告——哪怕 toArray
 * 已经给它补了 key。这不是我们的代码写错了 JSX 列表，是 RN 的已知行为
 * （它自己也留了注释：这个函数会导致子节点 key 重排、进而引起不必要的重挂载）。
 *
 * ## 为什么 web 上一直看不到
 *
 * react-native-web 的 `ScrollView` 只在 `stickyHeaderIndices` / `pagingEnabled`
 * 时才调 `React.Children.map`——我们两样都没用。所以这个警告**只在真机上出现**，
 * 端到端脚本和截图永远抓不到它。
 *
 * ## 为什么不能在这里用 `React.Children.map` 来补 key
 *
 * 因为**那正是把子节点标成 2 的那个操作**。补 key 必须用普通数组的 `Array.map`
 * + `cloneElement`，绕开 `mapIntoArray`：
 *
 *   · 元素本来没有 key → 补一个 → toArray 里 `null == callback.key` 不成立 → 不会再被标 2
 *   · 元素本来有 key（`.map` 出来的那些）→ 原样放过，不动它
 *   · 数组（`{items.map(...)}`）→ 往下走一层，两头的元素一起补
 *
 * `cloneElement` 会保留 `_store.validated`，所以本来就 validated 的静态子节点
 * 不会被这次克隆弄坏。
 */
import { cloneElement, isValidElement, type ReactNode } from 'react';

/**
 * 补 key。位置作 key——和 RN 自己 `toArray` 的做法一致，所以不会引入新的重挂载行为。
 *
 * 已经带 key 的不动：`.map` 出来的列表质量更高（键是业务 id），
 * 用位置键盖掉它反而会在列表重排时错位。
 */
export function withChildKeys(children: ReactNode): ReactNode {
  if (!Array.isArray(children)) return children;

  return children.map((child, i) => {
    if (Array.isArray(child)) return withChildKeys(child);
    if (!isValidElement(child)) return child;
    return child.key != null ? child : cloneElement(child, { key: `scroll-${i}` });
  });
}
