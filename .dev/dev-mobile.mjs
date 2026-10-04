/**
 * 在真机上跑开发版（Expo Go）。
 *
 * ## 为什么需要这个脚本
 *
 * 开发机不止一张网卡：WLAN（真正连着手机的那张）、VirtualBox 仅主机网卡、
 * Radmin VPN 的虚拟网卡。Metro 自己挑一张地址广告出去，挑错的表现是——
 *
 *   - Expo Go 一直转圈，连不上；或者更坏：
 *   - 连上了，但 App 从 Metro 地址（`Constants.expoConfig.hostUri`）推断出的
 *     API 地址也是错的，于是**每一条 AI 调用都静默退到本机兜底**，
 *     界面上只写「（本机）」，看起来像是模型不行。
 *
 * 两种都不报错，所以这里显式指定，并且**启动之前先把 API 探一遍**：
 * 探不通就现在说，而不是等你点完七道题、点了生成，才发现走了兜底。
 *
 * 用法：
 *   pnpm mobile                     # 自动取默认路由那张网卡的地址
 *   pnpm mobile -- --host 192.168.3.18
 *   SP_HOST=192.168.3.18 pnpm mobile
 */
import { spawn, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = 8787;
const METRO_PORT = 8081;

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

/** 所有非回环 IPv4，带网卡名，方便人工判断 */
function candidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

/**
 * 默认路由走的那张网卡 = 手机能连上的那张。
 *
 * 不用「挑第一个 192.168.x」这种启发式：这台机器上 VirtualBox 的仅主机网卡
 * 也是 192.168.56.x，会被挑中，然后怎么都连不上。问路由表才是准的。
 * 拿不到就退回启发式，并且把候选都打出来让人自己选。
 */
function defaultRouteAddress() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 | Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue).IPAddress",
      ],
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(out)) return out;
  } catch {
    // 非 Windows 或没有 powershell：走下面的启发式
  }
  const c = candidates();
  return (c.find((x) => x.address.startsWith('192.168.')) ?? c[0])?.address;
}

const host = arg('host') ?? process.env.SP_HOST ?? defaultRouteAddress();

if (!host) {
  console.error('✕ 找不到任何局域网地址。手动指定：pnpm mobile -- --host <你的IP>');
  process.exit(1);
}

/** 启动前先确认服务端在那个地址上真的能连上 */
async function probeApi() {
  const url = `http://${host}:${API_PORT}/health`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const body = await res.json();
    const llm = body.llm?.configured ? `真实模型：${body.llm.provider}` : '未配模型（会走本机兜底）';
    console.log(`✓ 服务端通了  ${url}\n  ${llm}`);
    return true;
  } catch (e) {
    console.log(`✕ 服务端没通  ${url}\n  ${e instanceof Error ? e.message : String(e)}`);
    console.log('  手机上的后果：访谈和生成都会静默退到本机兜底，界面只写「（本机）」。');
    console.log('  先另开一个终端跑：pnpm --filter @sp/server start');
    return false;
  }
}

console.log(`用这个地址对手机广播：${host}`);
const others = candidates().filter((c) => c.address !== host);
if (others.length) {
  console.log(`（本机其他网卡，手机连不上：${others.map((c) => `${c.address} ${c.name}`).join(' / ')}）`);
}
console.log('');

// 探不通也照样启动：落盘、界面这些不依赖服务端，照样能验
await probeApi();
console.log('');

console.log(`Expo Go 里手动输入：exp://${host}:${METRO_PORT}\n`);

const child = spawn(
  'pnpm',
  ['--filter', '@sp/mobile', 'exec', 'expo', 'start', '--go', '--lan', '--port', String(METRO_PORT)],
  {
    cwd: WORKSPACE,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, REACT_NATIVE_PACKAGER_HOSTNAME: host },
  },
);
child.on('exit', (code) => process.exit(code ?? 0));
