/**
 * 探 Metro 的 HMR websocket 通不通。
 *
 * ## 为什么单看 `/status` 不够
 *
 * 手机弹的那条「Cannot connect to Expo CLI」指向的是 `/hot` 这个 **websocket**，
 * 不是 HTTP。`http://IP:8081/status` 返回 `packager-status:running` 只证明
 * 「Metro 在」，不证明这条链路能建起来。两者可以一个通一个不通——
 * 而那正是「手机上一直弹警告、但电脑上看着一切正常」的成因。
 *
 * ## 它证明什么、不证明什么
 *
 * 通了 = Metro 的 HMR 是活的，**且从这台机器到那个地址的网络路径是通的**。
 * 不通 = 问题在 Metro 或网络，不在手机；这时候再去手机上找原因是白费力气。
 *
 * 反过来说：**这里通了、手机上还在弹**，那多半是手机那一次断了之后
 * Expo 的客户端没能自己接回来（它只在「曾经连上过」之后才弹这条警告）。
 * 那种情况在手机上重新加载一次就好，不用重启 Metro。
 *
 * Node 22 自带全局 WebSocket，不引入任何依赖。
 */
import { pathToFileURL } from 'node:url';

/** 和 `expo/src/async-require/hmr.ts` 里拼的是同一个端点 */
export function hmrUrl(host, port) {
  return `ws://${host}:${port}/hot?bundleEntry=index.bundle&platform=android`;
}

/**
 * 握手一次。**连上就算通**，不等 Metro 发消息——
 * 我们要验的是「这条网络路径能不能建起来」，不是 Metro 的业务逻辑。
 */
export function probeHmr(host, port, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // 已经关了就算了
      }
      resolve({ ok, detail, ms: Date.now() - started });
    };

    let ws;
    try {
      ws = new WebSocket(hmrUrl(host, port));
    } catch (e) {
      return finish(false, `构造失败：${e instanceof Error ? e.message : String(e)}`);
    }
    ws.onopen = () => finish(true, '握手成功');
    ws.onerror = (e) => {
      const msg = e?.message ?? e?.error?.message ?? e?.type ?? '(无 message)';
      finish(false, `握手失败：${msg}`);
    };
    setTimeout(() => finish(false, `${Math.round(timeoutMs / 1000)} 秒没有握手结果`), timeoutMs);
  });
}

/** 直接跑这个文件时才当命令行用；被 import 时不产生副作用 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.argv[2] ?? '127.0.0.1';
  const port = Number(process.argv[3] ?? 8081);
  console.log(`Metro HMR 端点：${hmrUrl(host, port)}\n`);

  const loop = await probeHmr('127.0.0.1', port);
  console.log(`  ${loop.ok ? '✓' : '✕'} 回环 127.0.0.1  (${loop.ms}ms)  ${loop.detail}`);

  if (host !== '127.0.0.1') {
    const lan = await probeHmr(host, port);
    console.log(`  ${lan.ok ? '✓' : '✕'} 局域网 ${host}  (${lan.ms}ms)  ${lan.detail}`);
  }

  console.log(
    loop.ok
      ? [
          '',
          '回环通 = Metro 的 HMR 是活的，这条是实打实的。',
          '局域网那条**只做参考**：实测这台机器连自己的 WLAN 地址都可能超时',
          '（Node 和 PowerShell 一样，且对一个什么都没监听的端口也超时），',
          '所以「局域网不通」不代表手机连不上——手机走的是另一条路。',
          '真正该看的是手机能不能刷出画面。',
        ].join('\n')
      : '\n回环也不通 = Metro 没在跑，或者 8081 上不是 Metro。'
  );
}
