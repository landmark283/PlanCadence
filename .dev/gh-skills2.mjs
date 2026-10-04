/** 深挖 expo-ios-hig 技能 + datawhale 的前端技能目录 */
import https from 'node:https';

const UA = 'dsh-research';
function get(host, path, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const req = https.request(
      { host, path, method: 'GET', headers: { Host: host, 'User-Agent': UA, Accept: '*/*' } },
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

// 1) dot-skills 里 .experimental 下的技能
console.log('########## pproenca/dot-skills :: skills/.experimental ##########');
try {
  const r = await get('api.github.com', '/repos/pproenca/dot-skills/git/trees/master?recursive=1');
  const j = JSON.parse(r.body.toString('utf8'));
  const hits = j.tree.filter((e) => e.type === 'blob' && e.path.startsWith('skills/.experimental/'));
  const bySkill = new Map();
  for (const e of hits) {
    const skill = e.path.split('/').slice(0, 3).join('/');
    if (!bySkill.has(skill)) bySkill.set(skill, []);
    bySkill.get(skill).push(e);
  }
  for (const [skill, files] of [...bySkill].sort()) {
    console.log(`\n  ${skill}  (${files.length} 文件, ${(files.reduce((s, f) => s + (f.size ?? 0), 0) / 1024).toFixed(1)} KB)`);
    for (const f of files.slice(0, 40)) console.log(`    ${String(f.size ?? 0).padStart(7)}  ${f.path.replace(skill + '/', '')}`);
  }
} catch (e) {
  console.log('  ERROR:', e.message);
}

// 2) datawhale 的前端技能目录
for (const p of [
  'catalog/coding-and-devtools/frontend-design.md',
  'catalog/coding-and-devtools/frontend-ui-engineering.md',
]) {
  console.log(`\n########## datawhalechina :: ${p} ##########`);
  try {
    const r = await get('raw.githubusercontent.com', `/datawhalechina/ai-skills-for-everyone/main/${p}`);
    console.log(r.status === 200 ? r.body.toString('utf8').slice(0, 2600) : `HTTP ${r.status}`);
  } catch (e) {
    console.log('  ERROR:', e.message);
  }
}
