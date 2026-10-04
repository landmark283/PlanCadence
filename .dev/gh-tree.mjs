/** 列出 GitHub 仓库文件树（用于检查技能仓库结构） */
import https from 'node:https';

const UA = 'dsh-research';
function get(host, path, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const req = https.request(
      { host, path, method: 'GET', headers: { Host: host, 'User-Agent': UA, Accept: 'application/vnd.github+json' } },
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
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const repos = [
  ['SAXEM1997/specpowers', 'main'],
  ['Abm32/runsight', 'main'],
];

for (const [full, branch] of repos) {
  console.log(`\n########## ${full} (${branch}) ##########`);
  try {
    const r = await get('api.github.com', `/repos/${full}/git/trees/${branch}?recursive=1`);
    if (r.status !== 200) {
      console.log(`  HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
      continue;
    }
    const j = JSON.parse(r.body.toString('utf8'));
    console.log(`  条目数 ${j.tree.length}  truncated=${j.truncated}`);
    for (const e of j.tree) {
      if (e.type !== 'blob') continue;
      if (e.path.startsWith('.git')) continue;
      console.log(`  ${String(e.size ?? 0).padStart(8)}  ${e.path}`);
    }
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}
