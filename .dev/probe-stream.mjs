/**
 * 一次性探测：配置里的模型到底会不会吐 `reasoning_content`。
 *
 * 直接决定「流式展示思考链」这个需求能不能真的做出来——
 * 如果对端只给最终答案，那 draft 那条路上能流的只有 YAML，
 * 展示 YAML 比转圈更糟。那就得改成流「阶段」。
 *
 * 只打印字段名和长度，不打印密钥、不打印完整正文。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(WORKSPACE, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const base = env.LLM_BASE_URL.replace(/\/+$/, '');
console.log('base =', base, '｜ model =', env.LLM_MODEL);

const res = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env.LLM_API_KEY}` },
  body: JSON.stringify({
    model: env.LLM_MODEL,
    stream: true,
    max_tokens: 256,
    messages: [
      { role: 'system', content: '你是学习规划助手，回答要短。' },
      { role: 'user', content: '我下周要考算法，只有晚上两小时，怎么安排前三天的复习？请先想一下再回答。' },
    ],
  }),
});

console.log('HTTP', res.status, res.headers.get('content-type'));
if (!res.ok) {
  console.log(await res.text());
  process.exit(1);
}

const seen = new Map();
let events = 0;
const decoder = new TextDecoder();
let buf = '';
let answer = '';
let reasoning = '';

for await (const chunk of res.body) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const raw = line.slice(5).trim();
    if (raw === '[DONE]') continue;
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    events++;
    const d = j.choices?.[0]?.delta ?? {};
    for (const k of Object.keys(d)) seen.set(k, (seen.get(k) ?? 0) + 1);
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    if (typeof d.reasoning === 'string') reasoning += d.reasoning;
    if (typeof d.content === 'string') answer += d.content;
  }
}

console.log('SSE 事件数：', events);
console.log('delta 里出现过的字段：', [...seen.entries()].map(([k, v]) => `${k}×${v}`).join(', ') || '(无)');
console.log('reasoning_content 长度：', reasoning.length);
console.log('content 长度：', answer.length);
console.log('reasoning 前 80 字：', JSON.stringify(reasoning.slice(0, 80)));
console.log('content 前 120 字：', JSON.stringify(answer.slice(0, 120)));
