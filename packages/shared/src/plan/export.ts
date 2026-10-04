/**
 * 导出：把计划变成**别人也能用**的两种格式。
 *
 * ## 为什么这件事必须有（不只是锦上添花）
 *
 * `.studyplan` 是自定义格式，这个项目的卖点也是它。但自定义格式有一个
 * 天然的风险：**它成了数据孤岛**——学生没法把它带进日历、也没法贴给同学。
 * 所以导出不是加分项，是让"自定义格式"这个选择站得住脚的必要条件。
 *
 * ## 生成和投递分开
 *
 * 这里只生成**字符串**，不碰文件系统也不碰分享面板。
 * 于是它可以被单测逐条盯着（ICS 的折行、转义、全天事件语义都容易写错，
 * 而写错的表现是"日历打不开这个文件"——那种错在真机上极难定位）。
 * 真正写文件和调分享面板在 App 侧，按平台分文件。
 *
 * ## ICS 上的几个容易写错的点
 *
 * 1. **必须 CRLF 换行**（RFC 5545）。用 `\n` 的日历文件有些客户端直接拒收。
 * 2. **折行按 75 字节而不是 75 字符**，而且不能把一个多字节字符切成两半。
 *    中文标题一折行就踩这个坑，且只在中文上出错，英文测试根本发现不了。
 * 3. **全天事件用 `DTSTART;VALUE=DATE`，`DTEND` 是"次日"**——DTEND 在 ICS 里是**开区间**。
 *    写成同一天会变成零长度事件，很多客户端直接不显示。
 * 4. **UID 要稳定**（用 planId + taskId），否则每次导出都是新事件，
 *    导入两次日历里就有两份。`SEQUENCE` 用计划版本号，让客户端知道这是更新。
 * 5. 值里的 `\` `;` `,` 和换行必须转义，否则会破坏行结构。
 */
import { SCHEMA_ID, type PlanFile, type Task } from './schema.ts';

export type ExportOptions = {
  /** 导出时刻（ISO）。写进文件头与 ICS 的 DTSTAMP */
  at: string;
};

/* ------------------------------------------------------------------ *
 * 公共小工具
 * ------------------------------------------------------------------ */

/** 单行化：任务标题按 schema 是单行，但手改过的文件不保证，防一手 */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/**
 * UTF-8 字节数。
 *
 * **刻意不用 `TextEncoder`**：shared 要保持「Hermes 上也能跑」这条护栏，
 * 而 TextEncoder 在 Hermes 上不保证存在（`apps/mobile` 里算文件大小就为此加了兜底）。
 */
function utf8Len(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

const STATUS_LABEL: Record<Task['status'], string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  skipped: '已跳过',
  blocked: '被卡住',
};

const TYPE_LABEL: Record<Task['type'], string> = {
  read: '阅读',
  practice: '练习',
  project: '项目',
  review: '复习',
  assess: '自测',
};

function fmtMinutes(min: number): string {
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

/** '2026-10-19' + n 天 */
function addDays(day: string, n: number): string {
  const ms = Date.parse(`${day}T12:00:00Z`) + n * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

/** Markdown 里需要转义的字符。标题是我们自己生成的，但学生能改任务标题 */
const escapeMd = (s: string) => oneLine(s).replace(/([\\`*_[\]<>])/g, '\\$1');

function taskLine(t: Task, byId: Map<string, Task>): string {
  const box = t.status === 'done' ? '[x]' : '[ ]';
  const bits = [fmtMinutes(t.estimateMin)];
  if (t.actualMin != null) bits.push(`实际 ${fmtMinutes(t.actualMin)}`);
  if (t.status !== 'todo' && t.status !== 'done') bits.push(STATUS_LABEL[t.status]);
  const deps = t.dependsOn
    .map((id) => byId.get(id)?.title)
    .filter((x): x is string => Boolean(x))
    .map((x) => `等待「${escapeMd(x)}」`);
  const notes = t.notes ? [`备注：${escapeMd(t.notes)}`] : [];
  const tail = [...bits, ...deps, ...notes].join(' · ');
  return `- ${box} ${escapeMd(t.title)}${tail ? ` — ${tail}` : ''}`;
}

/**
 * 导出成 Markdown。
 *
 * 目标读者是**学生自己和同学**：要能贴进聊天窗口、能当作业计划交上去。
 * 所以按「日期分组 + 勾选框」排，而不是按 schema 的字段顺序——
 * 后者是给机器看的，抄一遍没有意义。
 */
export function toMarkdown(plan: PlanFile, opts: ExportOptions): string {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const scheduled = plan.tasks
    .filter((t): t is Task & { scheduledFor: string } => Boolean(t.scheduledFor))
    .sort((a, b) => (a.scheduledFor < b.scheduledFor ? -1 : a.scheduledFor > b.scheduledFor ? 1 : a.id < b.id ? -1 : 1));
  const backlog = plan.tasks.filter((t) => !t.scheduledFor);

  const byDay = new Map<string, Task[]>();
  for (const t of scheduled) {
    const bucket = byDay.get(t.scheduledFor);
    if (bucket) bucket.push(t);
    else byDay.set(t.scheduledFor, [t]);
  }

  const out: string[] = [];
  out.push(`# ${escapeMd(plan.goal.statement)}`);
  out.push('');

  const head: string[] = [];
  if (plan.goal.deadline) head.push(`**截止** ${plan.goal.deadline}`);
  head.push(`**每周投入** ${fmtMinutes(plan.constraints.weeklyMinutes)}`);
  head.push(`**进度** ${plan.tasks.filter((t) => t.status === 'done').length}/${plan.tasks.length} 项`);
  out.push(head.join(' ｜ '));
  out.push('');

  if (plan.goal.successCriteria.length) {
    out.push('**做到什么算达标**');
    out.push('');
    for (const c of plan.goal.successCriteria) out.push(`- ${escapeMd(c)}`);
    out.push('');
  }

  if (plan.constraints.blackouts.length) {
    out.push('**不可用日期**');
    out.push('');
    for (const b of plan.constraints.blackouts) {
      out.push(`- ${b.from} ~ ${b.to}${b.reason ? `（${escapeMd(b.reason)}）` : ''}`);
    }
    out.push('');
  }

  out.push('## 排期');
  out.push('');
  if (!byDay.size) out.push('（暂无已排期的任务）');
  for (const [day, tasks] of byDay) {
    const done = tasks.filter((t) => t.status === 'done').length;
    const minutes = tasks.reduce((s, t) => s + t.estimateMin, 0);
    out.push(`### ${day} · ${done}/${tasks.length} 项 · ${fmtMinutes(minutes)}`);
    out.push('');
    for (const t of tasks) out.push(taskLine(t, byId));
    out.push('');
  }

  if (backlog.length) {
    out.push(`## 待排 · ${backlog.length} 项`);
    out.push('');
    out.push('> 还没排进具体日期的任务。等时间空出来，或者把前面的做完再排。');
    out.push('');
    for (const t of backlog) out.push(taskLine(t, byId));
    out.push('');
  }

  if (plan.milestones.length) {
    out.push('## 里程碑');
    out.push('');
    for (const m of plan.milestones) {
      const due = m.due ? `（截止 ${m.due}）` : '';
      out.push(`- **${escapeMd(m.title)}**${due} · ${m.status === 'done' ? '已达成' : m.status === 'active' ? '进行中' : '未开始'}`);
      for (const c of m.criteria) out.push(`  - ${escapeMd(c)}`);
    }
    out.push('');
  }

  if (plan.competences.length) {
    out.push('## 能力点');
    out.push('');
    out.push('| 能力点 | 当前 | 目标 |');
    out.push('|---|---|---|');
    for (const c of plan.competences) {
      out.push(`| ${escapeMd(c.name)} | ${c.current.toFixed(2)} | ${c.target.toFixed(2)} |`);
    }
    out.push('');
  }

  if (plan.resources.length) {
    out.push('## 资料');
    out.push('');
    for (const r of plan.resources) {
      const bits: string[] = [];
      if (r.deadline) bits.push(`截止 ${r.deadline}`);
      if (r.source) bits.push(r.source);
      out.push(`- [${escapeMd(r.title)}](${r.url})${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push(
    `由 AI 学习计划助手导出 · 计划 v${plan.version} · 格式 ${SCHEMA_ID} · 导出时间 ${opts.at}`,
  );
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * ICS（iCalendar）
 * ------------------------------------------------------------------ */

/** ICS 值转义。顺序要紧：反斜杠必须最先换，否则会把后面转义出来的反斜杠再转一遍 */
function escapeIcs(s: string): string {
  return oneLine(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/**
 * RFC 5545 折行：每行最多 75 **字节**，续行以单个空格开头。
 *
 * 关键是不能在多字节字符中间切断——切了就是乱码，而且**只在中文标题上出现**，
 * 用英文测试数据永远发现不了。
 *
 * 这里的实现按字符逐个累加字节数，所以天然不会切断字符。
 * 第二个参数是续行的起始预算（首行 75，续行减去前导空格）。
 */
export function foldIcsLine(line: string, limit = 75): string {
  if (utf8Len(line) <= limit) return line;

  const out: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of line) {
    const size = utf8Len(ch);
    if (used + size > limit) {
      out.push(current);
      current = ` ${ch}`; // 续行以空格开头，这个空格占 1 字节
      used = 1 + size;
      continue;
    }
    current += ch;
    used += size;
  }
  if (current) out.push(current);
  return out.join('\r\n');
}

/** '2026-10-19' → '20261019' */
const icsDate = (day: string) => day.replace(/-/g, '');

/** ISO 时间戳 → ICS 的 UTC 形式 '20261019T134600Z'。解析不了就返回 null */
function icsStamp(iso: string): string | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return `${new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`;
}

type IcsEvent = {
  uid: string;
  /** 全天事件的**起始**日期 */
  day: string;
  summary: string;
  description: string;
  /** 提前一天提醒。只给有硬截止的东西加 */
  alarm?: boolean;
};

function event(e: IcsEvent, stamp: string, sequence: number): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${stamp}`,
    // DTEND 是开区间，全天事件要填次日，否则是零长度、有些客户端直接不显示
    `DTSTART;VALUE=DATE:${icsDate(e.day)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(e.day, 1))}`,
    `SUMMARY:${escapeIcs(e.summary)}`,
    `DESCRIPTION:${escapeIcs(e.description)}`,
    'TRANSP:TRANSPARENT',
    `SEQUENCE:${sequence}`,
  ];
  if (e.alarm) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-P1D',
      `DESCRIPTION:${escapeIcs(e.summary)}`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

/**
 * 导出成 iCalendar。
 *
 * ## 为什么是全天事件
 *
 * `Task` 里只有 `scheduledFor`（日期），**没有开始时刻**。拿
 * `constraints.availableSlots` 里那个时段去凑一个开始时间看着更漂亮，
 * 但那是在**替学生编一个他没说过的时间点**——他填的是"周三晚上有空"，
 * 不是"这件 45 分钟的事从 19:00 开始"。日历上摆错时间比摆一整天更烦人。
 *
 * 所以统一全天事件，预估时长写进描述。少一点花哨，但说的都是真的。
 */
export function toIcs(plan: PlanFile, opts: ExportOptions): string {
  const stamp = icsStamp(opts.at) ?? '19700101T000000Z';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//studyplan//AI 学习计划助手//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(plan.meta.title)}`,
    `X-WR-CALDESC:${escapeIcs(plan.goal.statement)}`,
  ];

  for (const t of plan.tasks) {
    if (!t.scheduledFor) continue;
    const bits = [TYPE_LABEL[t.type], `预估 ${fmtMinutes(t.estimateMin)}`];
    if (t.actualMin != null) bits.push(`实际 ${fmtMinutes(t.actualMin)}`);
    bits.push(STATUS_LABEL[t.status]);
    if (t.notes) bits.push(`备注：${oneLine(t.notes)}`);
    lines.push(
      ...event(
        {
          // UID 里带 planId + taskId：重复导入是**更新同一个事件**，不是又加一份
          uid: `${plan.id}-${t.id}@studyplan`,
          day: t.scheduledFor,
          summary: t.title,
          description: bits.join(' · '),
        },
        stamp,
        plan.version,
      ),
    );
  }

  // 赛事截止单独成事件，并提前一天提醒——这是整个计划里唯一"过期就作废"的东西
  for (const r of plan.resources) {
    if (r.kind !== 'contest' || !r.deadline) continue;
    lines.push(
      ...event(
        {
          uid: `${plan.id}-${r.id}@studyplan`,
          day: r.deadline,
          summary: `截止：${r.title}`,
          description: `${r.url}${r.source ? ` · 来源 ${r.source}` : ''}`,
          alarm: true,
        },
        stamp,
        plan.version,
      ),
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map((l) => foldIcsLine(l)).join('\r\n') + '\r\n';
}

/** 导出文件名（不含扩展名）。用目标里前几个字，比 plan_czw01 好认 */
export function exportBaseName(plan: PlanFile, today: string): string {
  const head = oneLine(plan.goal.statement).replace(/[\\/:*?"<>|\s]+/g, '').slice(0, 12);
  return `学习计划-${head || plan.id}-${today}`;
}
