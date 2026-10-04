/** GitHub 定向搜索 · 第二批 */
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
  ['fsrs-ts', 'fsrs spaced repetition typescript scheduler'],
  ['vercel-ai', 'vercel ai sdk structured output'],
  ['superpowers', 'superpowers claude skills discipline'],
  ['anthropic-official', 'anthropics skills document processing'],
  ['browser-automation-skill', 'playwright browser automation skill claude agent'],
  ['rn-expo-skill', 'react native expo best practices skill agent'],
  ['skill-creator', 'skill creator meta skill write agent skills'],
  ['reanimated', 'react native reanimated gesture animation'],
  ['ics-export', 'icalendar ics generator typescript'],
  ['ui-components-rn', 'react native ui component library expo accessible'],
];

console.log('### 第二批搜索结果');
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
      console.log(`         ${(it.description ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  } catch (e) {
    console.log(`\n--- ${tag} --- ERROR: ${e.message}`);
  }
  await sleep(8000);
}
console.log('\n### 完成');
