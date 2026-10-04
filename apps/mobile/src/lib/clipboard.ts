/**
 * 复制到剪贴板。
 *
 * 包一层而不是到处直接 import `expo-clipboard`：这个包在 web 上是走
 * `navigator.clipboard` 的，而那条路**要求安全上下文**（https 或 localhost）——
 * 比赛现场如果从别的机器用 `http://192.168.x.x` 打开，复制会失败。
 * 把这件事收在一个地方，调用方只需要处理 true/false。
 */
import * as Clipboard from 'expo-clipboard';

/** 返回是否真的复制成功。失败不是异常，是"这个环境不让复制" */
export async function copyText(text: string): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(text);
  } catch {
    return false;
  }
}
