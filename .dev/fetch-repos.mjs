/**
 * 下载并解压 GitHub 仓库 tarball。
 *
 * 刻意不用 tar.exe：GitHub 打包的仓库含非 ASCII 文件名时 bsdtar 会报
 * "Invalid empty pathname" 并失败。Node 在 NTFS 上正确处理 UTF-8 文件名。
 *
 * 用法: node .dev/fetch-repos.mjs
 */
import https from 'node:https';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';

const UA = 'dsh-research';

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
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** 解析 tar：处理 ustar 前缀、GNU 长名('L')、pax 扩展头('x') */
function extractTar(buf, destRoot) {
  let p = 0;
  let pendingLongName = null;
  let pendingPaxPath = null;
  let count = 0;

  const str = (b, from, to) => b.slice(from, to).toString('utf8').replace(/\0.*$/, '').trim();

  while (p + 512 <= buf.length) {
    const header = buf.slice(p, p + 512);
    // 连续两个全零块表示结束
    if (header.every((b) => b === 0)) break;

    const name = str(header, 0, 100);
    const sizeField = str(header, 124, 136);
    const size = parseInt(sizeField, 8) || 0;
    const typeflag = String.fromCharCode(header[156]);
    const prefix = str(header, 345, 500);
    const dataStart = p + 512;
    const data = buf.slice(dataStart, dataStart + size);
    const dataBlocks = Math.ceil(size / 512) * 512;

    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0.*$/, '').trim();
      p = dataStart + dataBlocks;
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const text = data.toString('utf8');
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
      if (m) pendingPaxPath = m[1].trim();
      p = dataStart + dataBlocks;
      continue;
    }

    let rel = pendingPaxPath || pendingLongName || (prefix ? `${prefix}/${name}` : name);
    pendingPaxPath = null;
    pendingLongName = null;

    // 去掉 GitHub tarball 顶层的 owner-repo-sha/ 目录
    const parts = rel.split('/');
    if (parts.length > 1) rel = parts.slice(1).join('/');
    else {
      p = dataStart + dataBlocks;
      continue;
    }
    if (!rel) {
      p = dataStart + dataBlocks;
      continue;
    }

    const target = path.join(destRoot, rel);
    if (typeflag === '5' || rel.endsWith('/')) {
      fs.mkdirSync(target, { recursive: true });
    } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
      count++;
    }
    p = dataStart + dataBlocks;
  }
  return count;
}

const repos = [
  ['SAXEM1997/specpowers', 'main', '.dev/vendor/specpowers'],
  ['Abm32/runsight', 'main', '.dev/vendor/runsight'],
];

for (const [full, branch, outDir] of repos) {
  console.log(`\n########## ${full} ##########`);
  const r = await get('api.github.com', `/repos/${full}/tarball/${branch}`);
  if (r.status !== 200 || r.body.length < 1000) {
    console.log(`  下载失败 HTTP ${r.status} (${r.body.length} bytes)`);
    continue;
  }
  console.log(`  tarball ${(r.body.length / 1024).toFixed(1)} KB`);
  const tar = zlib.gunzipSync(r.body);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const n = extractTar(tar, outDir);
  console.log(`  解压 ${n} 个文件 -> ${outDir}`);
}
