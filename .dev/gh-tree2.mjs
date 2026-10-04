/** 查看两个候选仓库的文件树 */
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
  ['pproenca/dot-skills', 'master', /design|hig|expo|ui|frontend|style/i],
  ['datawhalechina/ai-skills-for-everyone', 'main', /design|frontend|ui|style/i],
];

for (const [full, branch, filter] of repos) {
  console.log(`\n########## ${full} (${branch}) ##########`);
  try {
    const r = await get('api.github.com', `/repos/${full}/git/trees/${branch}?recursive=1`);
    if (r.status !== 200) {
      console.log(`  HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 160)}`);
      continue;
    }
    const j = JSON.parse(r.body.toString('utf8'));
    console.log(`  条目 ${j.tree.length}  truncated=${j.truncated}`);
    const hits = j.tree.filter((e) => e.type === 'blob' && filter.test(e.path));
    console.log(`  匹配 ${hits.length} 个：`);
    for (const e of hits.slice(0, 70)) console.log(`  ${String(e.size ?? 0).padStart(8)}  ${e.path}`);
    if (hits.length > 70) console.log(`  ...（还有 ${hits.length - 70} 个）`);
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
  }
}
