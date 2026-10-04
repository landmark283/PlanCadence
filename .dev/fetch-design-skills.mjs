/**
 * 只下载并解压 dot-skills 里我们需要的三个技能目录。
 * 整个仓库有 9000+ 文件，全量解压没必要。
 */
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'dsh-research';
const WANTED = ['skills/.curated/design-review/', 'skills/.experimental/web-rules/', 'skills/.experimental/expo-ios-hig/'];

function get(host, reqPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const req = https.request(
      { host, path: reqPath, method: 'GET', headers: { Host: host, 'User-Agent': UA, Accept: '*/*' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const m = /^https:\/\/([^/]+)(\/.*)$/.exec(res.headers.location);
            if (m) return resolve(get(m[1], m[2], redirects + 1));
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.setTimeout(180000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

console.log('下载 tarball ...');
const r = await get('api.github.com', '/repos/pproenca/dot-skills/tarball/master');
if (r.status !== 200) {
  console.error(`HTTP ${r.status}`);
  process.exit(1);
}
console.log(`  ${(r.body.length / 1024 / 1024).toFixed(1)} MB，解压中 ...`);
const tar = zlib.gunzipSync(r.body);

const str = (b, from, to) => b.slice(from, to).toString('utf8').replace(/\0.*$/, '').trim();
const OUT = '.dev/vendor/dot-skills';
fs.rmSync(OUT, { recursive: true, force: true });

let p = 0;
let longName = null;
let paxPath = null;
let written = 0;

while (p + 512 <= tar.length) {
  const header = tar.slice(p, p + 512);
  if (header.every((b) => b === 0)) break;

  const name = str(header, 0, 100);
  const size = parseInt(str(header, 124, 136), 8) || 0;
  const typeflag = String.fromCharCode(header[156]);
  const prefix = str(header, 345, 500);
  const dataStart = p + 512;
  const data = tar.slice(dataStart, dataStart + size);
  const blocks = Math.ceil(size / 512) * 512;

  if (typeflag === 'L') { longName = data.toString('utf8').replace(/\0.*$/, '').trim(); p = dataStart + blocks; continue; }
  if (typeflag === 'x' || typeflag === 'g') {
    const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(data.toString('utf8'));
    if (m) paxPath = m[1].trim();
    p = dataStart + blocks;
    continue;
  }

  let rel = paxPath || longName || (prefix ? `${prefix}/${name}` : name);
  paxPath = null; longName = null;

  const parts = rel.split('/');
  if (parts.length > 1) rel = parts.slice(1).join('/');
  else { p = dataStart + blocks; continue; }

  const want = WANTED.some((w) => rel.startsWith(w));
  if (want && rel && !rel.endsWith('/') && (typeflag === '0' || typeflag === '\0' || typeflag === '')) {
    const target = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written++;
  }
  p = dataStart + blocks;
}

console.log(`  写出 ${written} 个文件 -> ${OUT}`);
for (const w of WANTED) {
  const dir = path.join(OUT, w);
  console.log(`  ${w} 存在=${fs.existsSync(dir)}`);
}
