/**
 * 服务端调用 —— 每一个都带**本地兜底**。
 *
 * ## 地址从哪来（刻意不用手配）
 *
 * 手机跑 Expo Go 时，Metro 的地址（`Constants.expoConfig.hostUri`）就是开发机的地址。
 * 服务端也跑在同一台机器上，所以直接把它换到 API 端口即可——
 * 演示时不需要先查 IP、改 .env、重启。想覆盖就设 `EXPO_PUBLIC_SP_SERVER`。
 *
 * ## 为什么这些函数永远不"失败"
 *
 * 它们返回的 `source` 不是诊断信息，而是**界面要显示的东西**：
 * 「AI 综述」和「系统综述」是两种不同的诚实说法。
 * 所以这里不做「抛异常让调用方决定」——调用方（访谈流、生成计划）
 * 本来就必须能离线工作，那就直接在这里把降级做掉，并且**说清楚降级原因**。
 */
import Constants from 'expo-constants';
import {
  assemblePlan,
  attachPlanResources,
  localDraft,
  nextLocalQuestion,
  parsePlan,
  serializePlan,
  QuestionSpec,
  type AdvisorView,
  type LearnerProfile,
  type PlanFile,
  type Resource,
} from '@sp/shared';

import { isOfflineOnly, OFFLINE_NOTE } from '@/lib/demo-mode';

/**
 * 超时。**这里的数值是按真实 LLM 延迟定的，不是拍脑袋。**
 *
 * 实测 deepseek-flash：出题 1–5 秒，生成计划 20–40 秒，复盘数秒。
 * 最初把生成计划定成 30 秒，结果是模型还在写、客户端已经放弃并静默回退到本机——
 * 界面上只显示「计划已生成（本机）」，看不出是被超时掐掉的。
 *
 * 宁可多等一会儿也不要静默降级：等待是有提示的（「正在生成…」），
 * 而静默降级会让人以为模型就这么点本事。
 */
const TIMEOUT_MS = 90_000;
/** 出题只要几秒，但网络抖动时也别太急 */
const INTERVIEW_TIMEOUT_MS = 25_000;
/** 复盘要调模型写一段话，比出题久 */
const REVIEW_TIMEOUT_MS = 60_000;

export type Source = 'llm' | 'local';

export type ApiResult<T> = { ok: true; value: T; source: Source; note: string } | { ok: false; error: string };

/** 开发机上 API 的默认端口，与 apps/server 的默认 PORT 保持一致 */
const DEFAULT_API_PORT = 8787;

export function serverUrl(): string | null {
  /**
   * 必须写成 `process.env.EXPO_PUBLIC_X` 这个**字面形式**。
   *
   * Expo 的内联是静态匹配：写成 `process.env?.EXPO_PUBLIC_X`（可选链）
   * 或先 `const env = process.env` 再取属性，都匹配不上，
   * 结果是被替换成 `undefined` 而**不报任何错**——表现就是"配了地址却还在走本地兜底"。
   * 这类静默失效最难查，因为两条路都能跑通，只是跑了差的那条。
   */
  const explicit = process.env.EXPO_PUBLIC_SP_SERVER;
  if (explicit && explicit.trim()) return explicit.trim().replace(/\/+$/, '');

  // 回退：从 Metro 的地址推断。手机上这几乎总是对的
  const hostUri = Constants.expoConfig?.hostUri;
  const host = hostUri?.split(':')[0];
  if (host) return `http://${host}:${DEFAULT_API_PORT}`;
  return null;
}

async function postJson(
  path: string,
  body: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const base = serverUrl();
  if (!base) return { ok: false, error: '未找到服务端地址' };

  // AbortController 保证「服务端在但卡住」时也能降级，而不是让学生一直等
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, error: `服务端返回 ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）` : msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * interview.nextTurn
 * ------------------------------------------------------------------ */

export type NextQuestion = {
  done: boolean;
  question: QuestionSpec | null;
  source: Source;
  note: string;
};

/**
 * 出下一题。服务端不可用或返回了不合格的题时，回退到共享层的本地题库。
 *
 * 这里再校验一次服务端的返回值，是因为**不能假设对端一定是我们的服务端**：
 * 端口扫到别的服务、代理返回一个 HTML 错误页，都可能让 `question` 变成垃圾。
 */
export async function fetchNextQuestion(
  profile: LearnerProfile,
  asked: QuestionSpec[],
): Promise<ApiResult<NextQuestion>> {
  const local = (note: string): ApiResult<NextQuestion> => {
    const q = nextLocalQuestion(asked);
    return { ok: true, value: { done: !q, question: q, source: 'local', note }, source: 'local', note };
  };

  // 演示模式：一次网络请求都不发。见 lib/demo-mode.ts
  if (isOfflineOnly()) return local(OFFLINE_NOTE);

  const res = await postJson('/interview/next', { profile, asked }, INTERVIEW_TIMEOUT_MS);
  if (!res.ok) return local(`没连上服务端（${res.error}），用本机题库继续`);

  const data = res.data as { ok?: boolean; done?: boolean; question?: unknown; source?: Source; note?: string };
  if (data?.ok !== true) return local('服务端拒绝了这次请求，用本机题库继续');

  if (data.done) {
    return {
      ok: true,
      value: { done: true, question: null, source: data.source === 'llm' ? 'llm' : 'local', note: data.note ?? 'ok' },
      source: data.source === 'llm' ? 'llm' : 'local',
      note: data.note ?? 'ok',
    };
  }

  const parsed = QuestionSpec.safeParse(data.question);
  if (!parsed.success) return local('服务端返回的题目结构不合法，用本机题库继续');

  return {
    ok: true,
    value: { done: false, question: parsed.data, source: data.source === 'llm' ? 'llm' : 'local', note: data.note ?? 'ok' },
    source: data.source === 'llm' ? 'llm' : 'local',
    note: data.note ?? 'ok',
  };
}

/* ------------------------------------------------------------------ *
 * planner.draft
 * ------------------------------------------------------------------ */

export type DraftedPlan = {
  planText: string;
  source: Source;
  note: string;
  /** 生成后的摘要，直接显示给学生 */
  summary: string;
};

export type DraftOptions = {
  id: string;
  /** 生成时刻（ISO 带时区字面量） */
  now: string;
  today: string;
  title: string;
};

/**
 * 生成计划。服务端可用就用服务端（模型 + 定点修复），否则用共享层的本地生成。
 *
 * 无论走哪条路，返回的计划文本**都要在这里重新解析一遍**：
 * 服务端说 ok 不代表这份文本一定能落盘，而落盘失败是最糟的失败方式。
 */
export async function draftPlan(profile: LearnerProfile, opts: DraftOptions): Promise<ApiResult<DraftedPlan>> {
  const local = (note: string): ApiResult<DraftedPlan> => {
    const assembled = assemblePlan(localDraft(profile, opts.today), {
      id: opts.id,
      now: opts.now,
      title: opts.title,
      profile,
    });
    if (!assembled.ok) return { ok: false, error: `本机生成失败：${assembled.error}` };
    const planText = serializePlan(assembled.plan);
    const check = parsePlan(planText);
    if (!check.ok) return { ok: false, error: `本机生成的计划无法解析：${check.error}` };
    return {
      ok: true,
      value: { planText, source: 'local', note, summary: `${check.plan.tasks.length} 个任务` },
      source: 'local',
      note,
    };
  };

  // 演示模式：生成计划那条的超时是 90 秒，现场是最不该赌它的一条
  if (isOfflineOnly()) return local(OFFLINE_NOTE);

  const res = await postJson('/plan/draft', {
    profile,
    today: opts.today,
    at: opts.now,
    id: opts.id,
    title: opts.title,
  });
  if (!res.ok) return local(`没连上服务端（${res.error}），用本机逻辑生成`);
  const data = res.data as { ok?: boolean; plan?: unknown; source?: Source; note?: string; summary?: string; error?: string };
  if (data?.ok !== true || typeof data.plan !== 'string') {
    return local(`服务端未能生成（${data?.error ?? '未知原因'}），用本机逻辑生成`);
  }

  const check = parsePlan(data.plan);
  if (!check.ok) return local('服务端返回的计划无法解析，用本机逻辑生成');

  return {
    ok: true,
    value: {
      planText: data.plan,
      source: data.source === 'llm' ? 'llm' : 'local',
      note: data.note ?? 'ok',
      summary: data.summary ?? `${check.plan.tasks.length} 个任务`,
    },
    source: data.source === 'llm' ? 'llm' : 'local',
    note: data.note ?? 'ok',
  };
}

/* ------------------------------------------------------------------ *
 * 工具调用：找资料
 * ------------------------------------------------------------------ */

export type AttachedResources = {
  resources: Resource[];
  links: { taskId: string; resourceIds: string[] }[];
  /** 检索实际用到的关键词，界面上要如实告诉学生「我按什么找的」 */
  queries: string[];
  /** 里面有没有实时抓回来的条目 */
  live: boolean;
  note: string;
};

/**
 * 按计划内容检索资料，返回要写回计划的**指令**。
 *
 * ## 本机路径为什么不依赖 `profile`
 *
 * 学生档案只活在内存里（落盘的只有计划），重开 App 之后就是 null。
 * 所以本机路径从**计划本身**取依据：能力点名字 + 目标原话。
 * 这其实比档案更准——能力点是生成计划时定下来的，就是这份计划在练的东西。
 * 档案里那份 `weakSpots` 有的话再并进去。
 *
 * ## 服务端那条路的意义只在赛事
 *
 * 资料检索是纯本地的（库在 shared 里），有服务端也快不了。
 * 真正需要服务端的是**实时赛程**——那要发 HTTP，而 shared 不许有 fetch。
 * 所以服务端拿不到时，本机路径照样给得出资料，只是赛事区只剩官网入口。
 */
export async function attachResources(
  plan: PlanFile,
  profile: LearnerProfile | null,
  today: string,
): Promise<ApiResult<AttachedResources>> {
  const tasks = plan.tasks.map((t) => ({ id: t.id, title: t.title }));
  const exclude = plan.resources.map((r) => r.id);
  const weakSpots = [...new Set([...(profile?.weakSpots ?? []), ...plan.competences.map((c) => c.name)])];

  const local = (note: string): ApiResult<AttachedResources> => {
    const out = attachPlanResources({
      tasks,
      profile: { weakSpots, level: profile?.level ?? null, goalStatement: plan.goal.statement },
      exclude,
    });
    return {
      ok: true,
      value: { resources: out.resources, links: out.links, queries: out.queries, live: false, note },
      source: 'local',
      note,
    };
  };

  // 演示模式：连实时赛程也不抓（这是唯一真的会发 HTTP 的一步）
  if (isOfflineOnly()) return local(OFFLINE_NOTE);

  const res = await postJson(
    '/tools/attach',
    { weakSpots, level: profile?.level ?? null, goalStatement: plan.goal.statement, tasks, exclude, today },
    REVIEW_TIMEOUT_MS,
  );
  if (!res.ok) return local(`没连上服务端（${res.error}），只用本机资料库`);

  const data = res.data as {
    ok?: boolean;
    resources?: unknown;
    links?: unknown;
    queries?: unknown;
    live?: unknown;
    note?: unknown;
  };
  if (data?.ok !== true || !Array.isArray(data.resources)) {
    return local('服务端返回的检索结果结构不合法，只用本机资料库');
  }

  const note = typeof data.note === 'string' ? data.note : 'ok';
  const live = data.live === true;
  return {
    ok: true,
    value: {
      resources: data.resources as Resource[],
      links: Array.isArray(data.links) ? (data.links as { taskId: string; resourceIds: string[] }[]) : [],
      queries: Array.isArray(data.queries) ? (data.queries as string[]) : weakSpots,
      live,
      note,
    },
    /**
     * `source` 一律是 `local`，因为**检索这个判断确实是本机做的**——
     * 有服务端时只是多拿了一份实时赛程，排序规则还是同一份代码。
     * 「哪些是实时抓的」由每条资源自己的 `source` 字段说明（卡片上就显示着），
     * 这里再用 `source` 说一遍只会打架。
     * `live` 单独给界面用，它说的是「这一轮有没有拿到实时数据」。
     */
    source: 'local',
    note,
  };
}

/* ------------------------------------------------------------------ *
 * advisor.proposeAdjustments
 * ------------------------------------------------------------------ */

/**
 * 复盘：让服务端用模型把引擎算好的调整讲成人话。
 *
 * 失败时**不返回错误给界面**，而是让调用方继续用本机的 `engineView`——
 * 复盘页在断网时必须仍然可用，这是产品要求。
 * 这里返回的 `note` 会显示给学生，所以降级原因要写得能看懂。
 */
export async function fetchReview(planText: string, today: string): Promise<ApiResult<AdvisorView>> {
  // 演示模式：调用方拿到失败之后会用本机的 engineView 把复盘算出来，
  // 所以这里返回失败是安全的降级，不是错误
  if (isOfflineOnly()) return { ok: false, error: OFFLINE_NOTE };

  // 这一路要调模型，给足时间；超时后界面仍然有本机算出来的结果兜着
  const res = await postJson('/plan/review', { plan: planText, today }, REVIEW_TIMEOUT_MS);
  if (!res.ok) return { ok: false, error: res.error };

  const data = res.data as { ok?: boolean; view?: unknown; note?: string; error?: string };
  const v = data?.view as AdvisorView | undefined;
  // 端口扫到别的服务、代理返回 HTML 错误页，都可能让 view 变成垃圾。
  // 只做最小结构校验——毕竟这不是我们能控制的对端。
  if (data?.ok !== true || !v || typeof v.narrative !== 'string' || !Array.isArray(v.adjustments)) {
    return { ok: false, error: data?.error ?? '服务端返回的复盘结构不合法' };
  }

  const fromLlm = v.narrativeSource === 'llm';
  return {
    ok: true,
    value: v,
    source: fromLlm ? 'llm' : 'local',
    note: data.note ?? 'ok',
  };
}
