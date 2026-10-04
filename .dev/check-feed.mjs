/**
 * 实时赛事接口现在还通不通？
 *
 * 演示前一天跑一次。这个接口是免费公开的，但它**会变**——
 * 对方改字段、限流、或者这台机器换了网络，都会让「实时赛程」那一段退化成
 * 只剩官网入口。降级本身不会报错，所以不主动测一次就发现不了。
 *
 * 用法：node .dev/check-feed.mjs
 */
const { fetchCodeforcesContests } = await import('../apps/server/src/tools/codeforces.ts');

const r = await fetchCodeforcesContests({ limit: 4 });

if (!r.contests.length) {
  console.log(`✕ 没拿到赛事：${r.note}`);
  console.log('  演示时的表现：赛事区只显示蓝桥杯 / CCPC / ICPC 的官网入口，没有倒计时。');
  console.log('  这是设计好的降级，不是崩溃——但如果想现场演示实时抓取，得先解决它。');
  process.exitCode = 1;
} else {
  console.log(`✓ ${r.note}（来源 ${r.source}）`);
  for (const c of r.contests) {
    console.log(`  · ${c.title}\n    ${c.url}\n    截止 ${c.deadline} · 校验于 ${c.verifiedAt}`);
  }
}
