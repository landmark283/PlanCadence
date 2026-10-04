/**
 * 计划文件读写的自证测试。
 *
 * 其中「示例文件必须能被解析」这条最重要：它保证 docs 与 examples 里的格式说明
 * 不会随 schema 演进而悄悄失效。文档说谎是这类项目最常见的腐化方式。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PlanFile, SCHEMA_ID } from './schema.ts';
import type { PlanFile as PlanFileType } from './schema.ts';
import {
  formatIssues,
  parsePlan,
  planPath,
  saveWithSnapshot,
  serializePlan,
  snapshotPath,
} from './io.ts';
// PlanStorage 是接口（纯类型），必须用 import type：Node 的类型剥离不会移除
// 普通 import 里的类型绑定，运行时会因「找不到该导出」而链接失败。
import type { PlanStorage } from './io.ts';

const T0 = '2026-10-06T20:00:00+08:00';

/** 归一化：把 undefined 抹平，避免 deepEqual 因「缺字段 vs 值为 undefined」误判 */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v));

function fixture(): PlanFileType {
  return PlanFile.parse({
    schema: SCHEMA_ID,
    id: 'plan_io',
    version: 3,
    meta: { title: '读写测试', created: T0, updated: T0 },
    goal: { statement: '验证往返一致', deadline: '2026-12-31', priority: 'high' },
    constraints: {
      weeklyMinutes: 600,
      availableSlots: [{ day: 'mon', from: '19:00', to: '21:00' }],
      maxSessionMinutes: 90,
      blackouts: [{ from: '2026-11-02', to: '2026-11-06', reason: '期中' }],
    },
    competences: [{ id: 'c_dp', name: '动态规划', target: 0.8, current: 0.25, evidence: ['t1'] }],
    milestones: [
      { id: 'm1', title: '基础', due: '2026-11-30', competenceIds: ['c_dp'], status: 'active', criteria: ['能独立写出背包'] },
    ],
    tasks: [
      {
        id: 't1',
        title: '01 背包手推五遍',
        milestoneId: 'm1',
        estimateMin: 120,
        type: 'practice',
        status: 'done',
        scheduledFor: '2026-10-07',
        actualMin: 150,
        difficulty: 0.6,
        resourceIds: ['r1'],
        notes: '一维滚动记住了',
      },
      { id: 't2', title: '完全背包', milestoneId: 'm1', dependsOn: ['t1'], estimateMin: 90, type: 'practice' },
    ],
    resources: [{ id: 'r1', title: 'OI Wiki', url: 'https://oi-wiki.org/dp/', kind: 'article' }],
    reviews: [{ at: T0, plannedTasks: 3, completedTasks: 2, loadFeedback: 0.62, notes: '比预想吃力' }],
    history: [{ at: T0, cmd: 'task.add', summary: '新增任务' }],
  });
}

describe('序列化往返', () => {
  it('plan → YAML → plan 完全一致', () => {
    const plan = fixture();
    const text = serializePlan(plan);
    const r = parsePlan(text);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    if (r.ok) assert.deepEqual(norm(r.plan), norm(plan));
  });

  it('往返后不残留 undefined（JSON_SCHEMA 无法表示 undefined）', () => {
    const plan = fixture();
    // fixture 的 resource 没有 source 字段，序列化时必须被丢弃而不是写出 null
    const text = serializePlan(plan);
    assert.ok(!text.includes('source: null'), '不应把缺失字段写成 null');
    assert.ok(!text.includes('undefined'), 'YAML 里不应出现 undefined 字面量');
    const r = parsePlan(text);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.plan.resources[0]!.source, undefined);
  });

  it('默认带文件头注释，可显式关闭', () => {
    const plan = fixture();
    assert.ok(serializePlan(plan).startsWith('# studyplan/v1'));
    assert.ok(!serializePlan(plan, { header: false }).startsWith('# studyplan/v1'));
  });

  it('生成的是人类可读的 YAML，而不是转义字符串', () => {
    const text = serializePlan(fixture());
    assert.ok(text.includes('title: 01 背包手推五遍'), '中文标题应原样出现');
    assert.ok(!text.includes('&ref_'), '不应生成锚点引用');
  });
});

describe('解析真实示例文件', () => {
  it('examples/demo.studyplan 必须能被解析且无 error', () => {
    const url = new URL('../../../../examples/demo.studyplan', import.meta.url);
    const text = fs.readFileSync(fileURLToPath(url), 'utf8');
    const r = parsePlan(text);
    assert.equal(r.ok, true, r.ok ? '' : `${r.error}\n${formatIssues(r.issues)}`);
    if (!r.ok) return;
    assert.equal(r.plan.schema, SCHEMA_ID);
    // 只断言「必须成立的结构性质」，不锁死具体条数与排期。
    // 之前断言 tasks.length === 6 和某个任务的 scheduledFor === null 是错的：
    // 只要有人正当地编辑示例文件（补内容、用 CLI apply 演练），测试就会变红，
    // 结果是大家学会忽略这条测试——那就等于没有测试。
    assert.ok(r.plan.tasks.length > 0, '示例应含任务');
    assert.ok(r.plan.milestones.length > 0, '示例应含里程碑');
    assert.ok(r.plan.competences.length > 0, '示例应含能力点');
    assert.ok(r.plan.resources.length > 0, '示例应含资源');
    assert.ok(r.plan.reviews.length > 0, '示例应含至少一次复盘');
    // 示例同时是格式的活文档：这些特性必须在示例里出现，否则新人看不到怎么用
    assert.ok(r.plan.tasks.some((t) => t.status === 'done'), '示例应体现完成状态');
    assert.ok(r.plan.tasks.some((t) => t.scheduledFor === null), '示例应体现「待排池」');
    assert.ok(r.plan.tasks.some((t) => t.pinned), '示例应体现手动上锁');
  });

  it('示例文件里的状态语义被正确区分（skipped vs blocked 不是同一个值）', () => {
    const url = new URL('../../../../examples/demo.studyplan', import.meta.url);
    const r = parsePlan(fs.readFileSync(fileURLToPath(url), 'utf8'));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    for (const t of r.plan.tasks) {
      assert.ok(['todo', 'doing', 'done', 'skipped', 'blocked'].includes(t.status), t.status);
    }
  });
});

describe('错误处理', () => {
  it('YAML 语法错误给出可读提示', () => {
    const r = parsePlan('schema: studyplan/v1\ntasks: [\n  - {id: ');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /YAML 解析失败/);
  });

  it('顶层不是对象时被拒绝', () => {
    for (const bad of ['', '   ', '42', '- a\n- b\n']) {
      const r = parsePlan(bad);
      assert.equal(r.ok, false, `应该拒绝：${JSON.stringify(bad)}`);
    }
  });

  it('缺少 schema 字段时明确指出，而不是报一堆字段错误', () => {
    const r = parsePlan('id: plan_x\nversion: 1\n');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /不支持的格式版本/);
      assert.match(r.error, /缺失 schema 字段/);
    }
  });

  it('未知 schema 版本被拒绝并说明只认哪个版本', () => {
    const r = parsePlan('schema: studyplan/v2\nid: plan_x\nversion: 1\n');
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.error, /studyplan\/v2/);
      assert.match(r.error, /studyplan\/v1/);
    }
  });

  it('字段类型错误会带上出错路径', () => {
    const plan = fixture();
    const text = serializePlan(plan).replace('estimateMin: 120', 'estimateMin: -5');
    const r = parsePlan(text);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.issues.some((i) => i.path.includes('estimateMin')), formatIssues(r.issues));
  });

  it('语义错误（悬空依赖）被拒绝', () => {
    const plan = fixture();
    const broken = { ...norm(plan) };
    broken.tasks[1].dependsOn = ['t_not_exist'];
    const r = parsePlan(serializePlan(PlanFile.parse(broken)));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /语义校验未通过/);
  });

  it('超周预算只记 warning，不阻断读取', () => {
    const plan = fixture();
    const heavy = norm(plan);
    heavy.tasks[1].estimateMin = 5000;
    heavy.tasks[1].scheduledFor = '2026-10-08';
    const r = parsePlan(serializePlan(PlanFile.parse(heavy)));
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    if (r.ok) assert.ok(r.warnings.some((w) => w.path.startsWith('week:')));
  });
});

describe('YAML 安全', () => {
  it('拒绝 !!js/function 之类的自定义标签（防止计划文件变成代码执行入口）', () => {
    const evil = 'schema: studyplan/v1\nevil: !!js/function "function(){ return 1 }"\n';
    const r = parsePlan(evil);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /YAML 解析失败/);
  });

  it('拒绝 python 风格的对象标签', () => {
    const r = parsePlan('schema: studyplan/v1\nx: !!python/object/apply:os.system ["echo pwned"]\n');
    assert.equal(r.ok, false);
  });

  it('日期样式的字符串保持为字符串，不会被解析成 Date 对象', () => {
    const plan = fixture();
    const r = parsePlan(serializePlan(plan));
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(typeof r.plan.tasks[0]!.scheduledFor, 'string');
      assert.equal(r.plan.tasks[0]!.scheduledFor, '2026-10-07');
    }
  });
});

describe('路径约定', () => {
  it('计划文件与快照路径稳定', () => {
    assert.equal(planPath('plan_czw01'), 'plan_czw01/plan.studyplan');
    assert.equal(snapshotPath('plan_czw01', 3), 'plan_czw01/versions/v3.studyplan');
  });
});

describe('formatIssues', () => {
  it('空列表有占位输出', () => {
    assert.equal(formatIssues([]), '（无问题）');
  });

  it('区分 error 与 warn 前缀', () => {
    const s = formatIssues([
      { level: 'error', path: 'tasks', message: '有环' },
      { level: 'warn', path: 'week:2026-W41', message: '超预算' },
    ]);
    assert.match(s, /✕ tasks: 有环/);
    assert.match(s, /! week:2026-W41: 超预算/);
  });
});

describe('saveWithSnapshot', () => {
  function memoryStorage(): PlanStorage & { files: Map<string, string> } {
    const files = new Map<string, string>();
    return {
      files,
      async readPlan(id) {
        return files.get(planPath(id)) ?? null;
      },
      async writePlan(id, text) {
        files.set(planPath(id), text);
      },
      async listSnapshots(id) {
        const prefix = `${id}/versions/`;
        return [...files.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => Number(/v(\d+)\.studyplan$/.exec(k)?.[1] ?? 0))
          .filter((n) => n > 0)
          .sort((a, b) => a - b);
      },
      async readSnapshot(id, version) {
        return files.get(snapshotPath(id, version)) ?? null;
      },
      async writeSnapshot(id, version, text) {
        files.set(snapshotPath(id, version), text);
      },
    };
  }

  it('写入当前计划，并补写缺失的上一版快照', async () => {
    const s = memoryStorage();
    const v3 = PlanFile.parse({ ...norm(fixture()), version: 3 });
    const v4 = PlanFile.parse({ ...norm(fixture()), version: 4 });
    await saveWithSnapshot(s, v4, { version: 3, text: serializePlan(v3) });

    assert.ok(s.files.has(planPath('plan_io')));
    assert.deepEqual(await s.listSnapshots('plan_io'), [3]);

    const snap = await s.readSnapshot('plan_io', 3);
    assert.ok(snap);
    const back = parsePlan(snap);
    assert.equal(back.ok, true);
    if (back.ok) assert.equal(back.plan.version, 3);

    const cur = parsePlan(s.files.get(planPath('plan_io'))!);
    assert.equal(cur.ok, true);
    if (cur.ok) assert.equal(cur.plan.version, 4);
  });

  it('快照存的是原始文本，原样落盘', async () => {
    const s = memoryStorage();
    const v4 = PlanFile.parse({ ...norm(fixture()), version: 4 });
    await saveWithSnapshot(s, v4, { version: 3, text: 'SENTINEL-原始文本' });
    assert.equal(await s.readSnapshot('plan_io', 3), 'SENTINEL-原始文本');
  });

  it('已有快照时不覆盖', async () => {
    const s = memoryStorage();
    await s.writeSnapshot('plan_io', 3, 'sentinel');
    const v4 = PlanFile.parse({ ...norm(fixture()), version: 4 });
    await saveWithSnapshot(s, v4, { version: 3, text: '不该被写入' });
    assert.equal(await s.readSnapshot('plan_io', 3), 'sentinel');
  });

  it('不传 previous 时只写当前计划，不产生快照', async () => {
    const s = memoryStorage();
    await saveWithSnapshot(s, PlanFile.parse({ ...norm(fixture()), version: 1 }));
    assert.deepEqual(await s.listSnapshots('plan_io'), []);
  });

  it('previous 版本不比当前旧时不写快照（避免版本倒挂）', async () => {
    const s = memoryStorage();
    const v4 = PlanFile.parse({ ...norm(fixture()), version: 4 });
    await saveWithSnapshot(s, v4, { version: 4, text: '同版本' });
    assert.deepEqual(await s.listSnapshots('plan_io'), []);
  });
});
