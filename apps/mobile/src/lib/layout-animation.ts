/**
 * 重排时让卡片「挪」过去，而不是瞬间跳到新位置。
 *
 * ## 这一处动效是原生专属，而且**验证不了**
 *
 * `LayoutAnimation` 在 react-native-web 上没有实现，调用是空操作。
 * 演示机是 Android，所以真机上有位移、浏览器上没有。
 * 这带来一个必须说清楚的后果：**截图和端到端脚本都证明不了它真的动了**，
 * 只能上真机看。所以这里刻意做得极小——它要是没生效，也只是回到「卡片直接跳」，
 * 不会有别的影响。
 *
 * ## 曲线对不齐 tokens
 *
 * `LayoutAnimation` 只认 linear / easeIn / easeOut / easeInEaseOut / spring，
 * 塞不进 `easeOut` 那条 cubic-bezier(0.23, 1, 0.32, 1)。
 * 取最接近的 `easeOut` 并把时长对齐 `motion.base`，是这一层能做到的上限。
 */
import { LayoutAnimation, Platform, UIManager } from 'react-native';

import { motion } from '@/theme';

let prepared = false;

function prepare() {
  if (prepared) return;
  prepared = true;
  // 旧架构（Paper）上 LayoutAnimation 默认是关的，必须显式打开；
  // 新架构（Fabric）上这个方法不存在。两种都试一下，失败不影响功能
  try {
    UIManager.setLayoutAnimationEnabledExperimental?.(true);
  } catch {
    // 新架构：不需要，也没有这个方法
  }
}

/** 放在会改变排期的 dispatch **之前**调用，作用于下一次布局变化 */
export function animateNextLayout(): void {
  if (Platform.OS === 'web') return;
  prepare();
  LayoutAnimation.configureNext({
    duration: motion.base,
    update: { type: LayoutAnimation.Types.easeOut },
    create: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
    delete: { type: LayoutAnimation.Types.easeOut, property: LayoutAnimation.Properties.opacity },
  });
}
