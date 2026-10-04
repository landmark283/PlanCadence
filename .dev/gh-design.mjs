/** 前端设计相关的 skill 与设计系统调研 */
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
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const QUERIES = [
  ['design-skill', 'frontend design skill claude agent ui'],
  ['design-skill2', 'web design review skill agent skills aesthetic'],
  ['m3-rn', 'material design 3 react native'],
  ['design-tokens', 'design tokens tailwind nativewind react native'],
  ['rn-uikit', 'react native expo ui kit components open source'],
  ['design-system', 'mobile design system tokens typography scale'],
  ['ai-web-design', 'ai friendly web design skill coding agents'],
  ['ui-skill', 'ui ux design skill marketplace agent'],
  ['motion-mobile', 'react native animation micro interaction library'],
  ['chinese-design', '中文 移动端 设计系统 组件库 开源'],
];

console.log('### 前端设计调研');
for (const [tag, q] of QUERIES) {
  try {
    const r = await get('api.github.com', `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=6`);
    if (r.status !== 200) {
      console.log(`\n--- ${tag} --- HTTP ${r.status}`);
      await sleep(8000);
      continue;
    }
    const j = JSON.parse(r.body.toString('utf8'));
    console.log(`\n--- ${tag} :: "${q}" (total ${j.total_count}) ---`);
    for (const it of j.items ?? []) {
      console.log(`  ★${String(it.stargazers_count).padStart(6)}  ${it.full_name}  [${it.language ?? '-'}]  ${(it.pushed_at ?? '').slice(0, 10)}`);
      console.log(`         ${(it.description ?? '').replace(/\s+/g, ' ').slice(0, 135)}`);
    }
  } catch (e) {
    console.log(`\n--- ${tag} --- ERROR: ${e.message}`);
  }
  await sleep(8000);
}
console.log('\n### 完成');
