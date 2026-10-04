/**
 * 把一个文本文件交给用户（浏览器）。
 *
 * ## 为什么 web 上不用 `expo-sharing`
 *
 * 查过它的 web 实现：`shareAsync` 只是转调 `navigator.share`，而且分享的是一个
 * **url** 而不是文件。`navigator.share` 在桌面 Chrome 上经常不存在，
 * 对文件分享还要额外过 `navigator.canShare({files})`。也就是说这条路上
 * 「能不能用」取决于浏览器，而**下载在所有浏览器上都成立**。
 *
 * 所以 web 这份走 Blob + `<a download>`，和原生那份是两条真实不同的实现——
 * 这正是平台分文件存在的意义，不是偷懒的复制粘贴。
 */
export type Delivered = { ok: true; note: string } | { ok: false; error: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function deliverTextFile(filename: string, mime: string, content: string): Promise<Delivered> {
  try {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器来不及取数据，取消下载。延后回收
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return { ok: true, note: `已开始下载 ${filename}` };
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}
