/**
 * 滚动容器 —— 全应用唯一的 `ScrollView` 用法。
 *
 * ## 它存在的唯一理由：原生上那个 key 警告
 *
 * `ScrollView` 在原生上会无条件跑一遍 `React.Children.toArray(props.children)`，
 * 而那会把**没有 key 的直接子节点**标成 `_store.validated = 2`，
 * Fabric 的 `warnForMissingKey` 就为这个条件报
 * 「Each child in a list should have a unique "key" prop」。
 * 详细机制写在 `@/lib/child-keys` 的文件头。
 *
 * 关键点是：**这个问题只在真机上出现**（react-native-web 的 ScrollView 不跑那句），
 * 所以截图、端到端、类型检查全都看不见它。靠「记得给每个 `{}` 子节点加 key」
 * 是守不住的——`app/` 下有十来个 ScrollView、几十个子节点，
 * 而且以后每加一个条件块都会重新踩一次。
 *
 * 所以收成一层：谁都不用记得，`ScrollBody` 自己补。`test/scroll-body.test.mjs`
 * 里有一条静态检查，禁止 `app/` 与 `components/` 直接使用 `ScrollView`。
 *
 * ## 它是 `ScrollView` 的直接替身
 *
 * 属性原样透传（`contentContainerStyle` / `keyboardShouldPersistTaps` 都照旧），
 * 所以替换调用点只需要改标签名。
 */
import { ScrollView, type ScrollViewProps } from 'react-native';

import { withChildKeys } from '@/lib/child-keys';

export function ScrollBody({ children, ...rest }: ScrollViewProps) {
  return <ScrollView {...rest}>{withChildKeys(children)}</ScrollView>;
}
