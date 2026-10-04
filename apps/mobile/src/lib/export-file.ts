/**
 * 把一个文本文件交给用户（原生）。
 *
 * ## 为什么导出文件写 cache，而计划文件写 document
 *
 * `plan-storage.ts` 里刻意选了 `Paths.document`，因为那是学生的**唯一一份计划**，
 * cache 被系统清掉就等于把计划删了。这里正好相反：导出的是一份**副本**，
 * 用户马上就会把它存到别处（下载目录、聊天窗口、日历）。留在 cache 里
 * 才是对的——它是临时产物，系统该清就清。
 *
 * ## 分享面板不可用时要说清楚文件在哪
 *
 * `Sharing.isAvailableAsync()` 为假时不报错，而是把路径告诉用户——
 * "导出失败"和"导出了但没法一键分享"是两件事，后者用户自己也能拿到文件。
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export type Delivered = { ok: true; note: string } | { ok: false; error: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function deliverTextFile(filename: string, mime: string, content: string): Promise<Delivered> {
  try {
    const f = new File(Paths.cache, filename);
    // 同名文件已存在时 create() 会抛错，先删掉。导出同名文件是常见操作
    if (f.exists) f.delete();
    f.create();
    f.write(content);

    if (!(await Sharing.isAvailableAsync())) {
      return { ok: true, note: `已导出到 ${f.uri}（这台设备没有分享面板，去文件管理器取）` };
    }
    await Sharing.shareAsync(f.uri, { mimeType: mime, dialogTitle: '导出学习计划' });
    return { ok: true, note: '已导出，选择要保存或发送到哪里' };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
