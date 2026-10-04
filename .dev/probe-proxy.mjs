/**
 * 本地代理探活 + CONNECT 隧道验证
 * 用法: node .dev/probe-proxy.mjs [port...]
 */
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

const PORTS = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [10808, 7897, 7890, 10809, 1080, 8080];
const HOST = '127.0.0.1';

function tcpProbe(port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect(port, HOST);
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

function openTunnel(port, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, HOST);
    sock.setTimeout(20000, () => reject(new Error('tunnel timeout')));
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nUser-Agent: dsh-research\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let done = false;
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0 || done) return;
      done = true;
      const head = buf.slice(0, idx).toString('latin1');
      if (!/^HTTP\/1\.[01] 200/.test(head)) return reject(new Error('CONNECT 被拒: ' + head.split('\r\n')[0]));
      const rest = buf.slice(idx + 4);
      sock.pause();
      sock.removeAllListeners('data');
      if (rest.length) sock.unshift(rest);
      const t = tls.connect({ socket: sock, servername: host }, () => resolve(t));
      t.on('error', reject);
    });
  });
}

function tlsGet(sock, host, path) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = https.request(
      { createConnection: () => sock, host, path, method: 'GET', headers: { Host: host, 'User-Agent': 'dsh-research', Accept: 'application/vnd.github+json', Connection: 'close' } },
      (res) => { res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) })); }
    );
    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

console.log('### TCP 探活');
const open = [];
for (const p of PORTS) {
  const ok = await tcpProbe(p);
  console.log(`  ${HOST}:${p} -> ${ok ? 'OPEN' : 'closed'}`);
  if (ok) open.push(p);
}

if (!open.length) {
  console.log('\n没有可用代理。但直连可用，不影响开发。');
  process.exit(0);
}

console.log('\n### 经代理访问 api.github.com');
for (const p of open) {
  try {
    const t0 = Date.now();
    const sock = await openTunnel(p, 'api.github.com');
    const r = await tlsGet(sock, 'api.github.com', '/rate_limit');
    console.log(`  :${p} -> HTTP ${r.status} (${Date.now() - t0} ms, ${r.body.length} bytes)`);
    sock.destroy();
  } catch (e) {
    console.log(`  :${p} -> 失败: ${e.message}`);
  }
}

console.log('\n### 经代理访问 registry.npmjs.org');
for (const p of open) {
  try {
    const t0 = Date.now();
    const sock = await openTunnel(p, 'registry.npmjs.org');
    const r = await tlsGet(sock, 'registry.npmjs.org', '/expo');
    console.log(`  :${p} -> HTTP ${r.status} (${Date.now() - t0} ms, ${r.body.length} bytes)`);
    sock.destroy();
  } catch (e) {
    console.log(`  :${p} -> 失败: ${e.message}`);
  }
}
