/**
 * GitHub 仓库搜索 + 网络探活（Node 直连，绕开 schannel）
 * 用法: node .dev/gh-search.mjs
 * 说明: api.github.com 未认证搜索限流 10 次/分钟，脚本内置 8s 间隔。
 */
import https from 'node:https';

const UA = 'dsh-research';

function get(host, path, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 4) return reject(new Error('too many redirects'));
    const req = https.request(
      { host, path, method: 'GET', headers: { Host: host, 'User-Agent': UA, Accept: 'application/vnd.github+json', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const m = /^https:\/\/([^/]+)(\/.*)$/.exec(res.headers.location);
            if (m) return resolve(get(m[1], m[2], headers, redirects + 1));
          }
          resolve({ status: res.statusCode, headers: res.headers, body });
        });
      }
    );
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. 探活 ----------
console.log('### 连通性探活');
try {
  const t0 = Date.now();
  const r = await get('api.github.com', '/rate_limit');
  console.log(`api.github.com 直连 -> HTTP ${r.status} (${Date.now() - t0} ms)`);
  if (r.status === 200) {
    const j = JSON.parse(r.body.toString('utf8'));
    console.log(`  core: ${j.resources.core.remaining}/${j.resources.core.limit}  search: ${j.resources.search.remaining}/${j.resources.search.limit}`);
  }
} catch (e) {
  console.log(`api.github.com 直连失败: ${e.message}`);
  console.log('  -> 需要回退到 CONNECT 隧道版（但本地无代理监听，此路大概率也不通）');
  process.exit(1);
}

// ---------- 2. 搜索 ----------
const QUERIES = [
  ['expo-monorepo', 'expo monorepo pnpm template in:name,description,readme'],
  ['rn-starter', 'react native expo starter template nativewind in:name,description'],
  ['structured-output', 'structured output llm zod typescript in:name,description'],
  ['fastify-zod', 'fastify zod type provider in:name,description'],
  ['spaced-repetition', 'spaced repetition scheduler algorithm javascript in:name,description'],
  ['claude-skills', 'claude skills in:name,description'],
  ['awesome-skills', 'awesome claude code skills in:name,description'],
  ['ai-study-planner', 'ai study planner llm in:name,description'],
  ['agent-skills-lib', 'agent skills library marketplace in:name,description'],
  ['plan-scheduler', 'task scheduling algorithm typescript dependency graph in:name,description'],
];

console.log('\n### 仓库搜索结果');
for (const [tag, q] of QUERIES) {
  try {
    const url = `/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`;
    const r = await get('api.github.com', url);
    if (r.status !== 200) {
      console.log(`\n--- ${tag} --- HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`);
      await sleep(8000);
      continue;
    }
    const j = JSON.parse(r.body.toString('utf8'));
    console.log(`\n--- ${tag} :: "${q}" (total ${j.total_count}) ---`);
    for (const it of j.items ?? []) {
      const age = it.pushed_at ? it.pushed_at.slice(0, 10) : '?';
      console.log(`  ★${String(it.stargazers_count).padStart(6)}  ${it.full_name}  [${it.language ?? '-'}]  last_push ${age}`);
      console.log(`         ${(it.description ?? '').replace(/\s+/g, ' ').slice(0, 150)}`);
    }
  } catch (e) {
    console.log(`\n--- ${tag} --- ERROR: ${e.message}`);
  }
  await sleep(8000);
}
console.log('\n### 完成');
