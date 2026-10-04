/**
 * 文件原子读写的小工具。
 *
 * 单独抽出来是为了让 `tools/` 的命令行也能复用——CLI 需要「就地写回同一个文件 +
 * 旁边放快照」，与 `nodeFsStorage` 的 `<root>/<planId>/…` 布局不同，
 * 但「先写临时文件再 rename」这部分的正确性是一样的，不该抄两遍。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export async function readTextOrNull(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * 先写临时文件再 rename。
 *
 * 直接 writeFile 到目标路径时，若进程在中途挂掉会留下半截文件；
 * 而计划文件一旦损坏，学生丢掉的是整个学习计划。rename 在同分区上是原子的。
 */
export async function writeTextAtomic(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}
