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
 * 两种都不报错，所以这里显式指定，并且**启动之前先把两条链路都探一遍**：
 *
 *   1. `GET /health` —— 我们自己的服务端（AI 功能靠它）
 *   2. Metro 的 **HMR websocket** —— 手机弹不弹那条红框警告靠它
 *
 * 第 2 条是后加的，因为踩过一次：手机上弹「Cannot connect to Expo CLI」，
 * 而电脑上 `http://IP:8081/status` 明明返回 `packager-status:running`、
 * Metro 也活着——**HTTP 通不代表 websocket 能建起来**，而那条警告说的是后者。
 * 现在启动时就把这个端点握手一次，通不通当场说清楚，
 * 不用等手机上弹红框才发现。
 *
 * 用法：
 *   pnpm mobile                     # 自动取默认路由那张网卡的地址
 *   pnpm mobile -- --host 192.168.3.18
 *   SP_HOST=192.168.3.18 pnpm mobile
 */
import { spawn, execFileSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeHmr } from './probe-hmr.mjs';

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

/** 8081 上是不是已经有东西在监听 */
function portBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/**
 * Metro 的 HMR websocket 探一遍。
 *
 * 这条就是手机弹「Cannot connect to Expo CLI」时说的那个连接。
 *
 * ## 局域网那一条只做参考，**不要**当成判据
 *
 * 踩过的坑：一开始这里把「局域网握手失败」报成 ✕ 并下结论「问题在网络路径」。
 * 那是错的——实测这台机器**根本连不通自己的局域网地址**：
 * `192.168.3.18:8081` 和 `:8787` 从本机都是超时（Node 和 PowerShell 一样），
 * 而 8787 上当时**什么都没有监听**（本该是 connection refused，却也超时）。
 * 也就是说这个环境下「自己访问自己的 WLAN 地址」这条路本身就不通，
 * 与 Metro、与手机都无关。手机走的是另一条路（真实网卡进、出，不过本机回环）。
 *
 * 所以：**回环通 = Metro 的 HMR 是活的**，这条是实打实的；
 * 局域网那条通了是额外的确信，不通则什么都不能说明。
 * 一个会误报的检查比没有检查更坏——它会把人的注意力引到错的地方。
 */
async function probeMetro() {
  const loop = await probeHmr('127.0.0.1', METRO_PORT);
  if (!loop.ok) {
    console.log(`· Metro 还没在 ${METRO_PORT} 上（下面会启动一个）`);
    return false;
  }
  console.log(`✓ Metro HMR 回环通  ws://127.0.0.1:${METRO_PORT}/hot  (${loop.ms}ms)  ← Metro 是活的`);

  const lan = await probeHmr(host, METRO_PORT);
  if (lan.ok) {
    console.log(`✓ Metro HMR 局域网也通  ws://${host}:${METRO_PORT}/hot  (${lan.ms}ms)`);
  } else {
    console.log(`· Metro HMR 局域网超时（${lan.detail}）—— **仅供参考，不代表手机连不上**：`);
    console.log('  本机访问自己的 WLAN 地址在这个环境下就是不通（防火墙/策略），手机走的是另一条路。');
  }
  return true;
}

console.log(`用这个地址对手机广播：${host}`);
const others = candidates().filter((c) => c.address !== host);
if (others.length) {
  console.log(`（本机其他网卡，手机连不上：${others.map((c) => `${c.address} ${c.name}`).join(' / ')}）`);
}
console.log('');

// 探不通也照样启动：落盘、界面这些不依赖服务端，照样能验
await probeApi();

/**
 * 8081 已经被占了就先说清楚。
 *
 * 两个原因：`expo start` 遇到端口占用会**交互式地问要不要换端口**，
 * 而这里 stdio 是 inherit，那个提问会突兀地出现在终端里；
 * 更要紧的是那个已经在跑的 Metro 广告的地址未必是 `host`
 * （比如它是在换过网卡、换过 IP 之前起的），手机连上它的表现就是各种连不上。
 */
const busy = await portBusy(METRO_PORT);
if (busy) {
  console.log('');
  console.log(`⚠ ${METRO_PORT} 上已经有一个 Metro 在跑了。`);
  console.log('  如果手机连的就是它，下面这个新实例会被 Expo 提示换端口——先确认要不要停掉旧的那个。');
  console.log('  旧实例如果是换 IP 之前起的，它广告的还是老地址，手机连不上。');
}
await probeMetro();

console.log('');
console.log(`Expo Go 里手动输入：exp://${host}:${METRO_PORT}`);
console.log('手机上如果弹「Cannot connect to Expo CLI」——那条是**开发期**的警告，说的是');
console.log('Fast Refresh 的 websocket（Metro 的 /hot），不是 App 出了问题。Expo 只在');
console.log('「曾经连上过、后来断了」时才弹它，而它自己不一定能接回来。处理办法：');
console.log('  1. 看上面那行「Metro HMR 回环通」在不在。在，就说明 Metro 是好的，不用重启。');
console.log('  2. **在手机上重新加载一次**（Expo Go 里下拉，或按 r）。');
console.log('  3. 还不行再查网络：Windows 防火墙是否放行 node.exe、路由器有没有开 AP 隔离。');
console.log('单独诊断这条链路：node .dev/probe-hmr.mjs ' + host);
console.log('');

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
