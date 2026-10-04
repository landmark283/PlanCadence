/**
 * 把 examples/demo.studyplan 生成为移动端的开发用 fixture。
 *
 * 为什么是「生成」而不是手工复制：示例文件同时是 io.test.ts 的输入，
 * 手抄一份必然漂移。改了示例后重跑这个脚本即可。
 *
 * 长期方案是 App 从本地文件读学生自己的计划；这个 fixture 只服务于
 * 开发期和演示兜底。
 */
import fs from 'node:fs';

const SRC = 'examples/demo.studyplan';
const OUT = 'apps/mobile/src/fixtures/demo-plan.ts';

const text = fs.readFileSync(SRC, 'utf8');

const content = `/**
 * 开发用示例计划。**由 .dev/gen-fixture.mjs 生成，不要手工编辑。**
 * 源文件：${SRC}
 * 重新生成：node .dev/gen-fixture.mjs
 *
 * 为什么用 JSON.stringify 而不是模板字符串：YAML 里出现反引号或 \${} 就会炸，
 * 转义交给 JSON.stringify 才不会留坑。
 */
export const DEMO_PLAN_TEXT = ${JSON.stringify(text)};
`;

fs.mkdirSync('apps/mobile/src/fixtures', { recursive: true });
fs.writeFileSync(OUT, content, 'utf8');
console.log(`写出 ${OUT}（${text.length} 字符）`);
