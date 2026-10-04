/**
 * 计划相关的 HTTP 端点。
 *
 * ## 一条关键设计：计划内容「文本进、文本出」，服务端不持有状态
 *
 * `.studyplan` 文件存在学生手机本地（expo-file-system）。服务端只做两件事：
 *   1. 纯计算（校验、复盘、应用调整）——这些逻辑本来就在 packages/shared 里，是纯函数
 *   2. 代理 LLM 调用（密钥不能下发到 App）
 *
 * 好处：断网时 App 仍能用本机逻辑完成复盘（`engineView`）；
 * 也不需要处理「服务端版本与手机版本谁更新」这类多端一致性问题。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AdvisorOutput,
  PLAN_FILE_NAME,
  SCHEMA_ID,
  applyCommand,
  buildAdvisorMessages,
  engineView,
  formatIssues,
  parsePlan,
  reviewPlan,
  serializePlan,
  validateAdvisorOutput,
} from '@sp/shared';
import type { AdvisorView, PlanFile, PlanIssue, Review } from '@sp/shared';
import { completeJson } from '@sp/llm-client';
import type { LlmProvider } from '@sp/llm-client';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');
const StampStr = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/, '时间戳必须是 ISO 8601');

const PlanText = z.object({
  /** `.studyplan` 文件的完整文本 */
  plan: z.string().min(1).max(2_000_000),
});

const ReviewBody = PlanText.extend({
  today: DateStr.optional(),
  /** false 时强制走引擎措辞（降级路径），便于 App 在弱网下主动降级 */
  useLlm: z.boolean().optional(),
});

const ApplyBody = PlanText.extend({
  today: DateStr.optional(),
  at: StampStr.optional(),
  /** 学生逐条接受的任务 id。省略表示全部接受。 */
  accepted: z.array(z.string().min(1).max(32)).max(200).optional(),
  /** 学生填写的复盘记录。命令行/客户端不填时不写，避免伪造主观数据。 */
  review: z
    .object({
      plannedTasks: z.number().int().min(0),
      completedTasks: z.number().int().min(0),
      loadFeedback: z.number().min(0).max(1).nullable().optional(),
      notes: z.string().max(2000).optional(),
    })
    .optional(),
});

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 解析计划文本，失败时统一成 400 + 结构化问题列表 */
type ReadPlanResult =
  | { ok: true; plan: PlanFile; warnings: PlanIssue[] }
  | { ok: false; error: string; issues: PlanIssue[] };

function readPlan(text: string): ReadPlanResult {
  const r = parsePlan(text);
  if (!r.ok) return { ok: false, error: r.error, issues: r.issues };
  return { ok: true, plan: r.plan, warnings: r.warnings };
}

export function registerPlanRoutes(app: FastifyInstance, provider: LlmProvider | null): void {
  /**
   * 根路径。
   *
   * 没有它时，浏览器打开服务地址会看到一个裸的
   * `{"message":"Route GET:/ not found","statusCode":404}` ——
   * 第一反应必然是「后端挂了」。实际上那只是「这个路径没有路由」。
   * 给一个 200 的端点清单，让「服务活着」这件事变得一目了然。
   */
  app.get('/', async () => ({
    service: 'study-plan-assistant',
    ok: true,
    schema: SCHEMA_ID,
    llm: provider ? { configured: true, provider: provider.name } : { configured: false, hint: '从 .env.example 复制 .env 并填写 LLM_*' },
    endpoints: {
      'GET /health': '服务与 LLM 配置状态（不含密钥）',
      'POST /interview/next': '访谈出下一题（body: { profile, asked, useLlm? }）',
      'POST /plan/draft': '由访谈档案生成计划文本（body: { profile, today?, useLlm? }）',
      'POST /plan/validate': '校验 .studyplan 文本',
      'POST /plan/review': '复盘：引擎计算 + LLM 叙述（body: { plan, today?, useLlm? }）',
      'POST /plan/apply': '应用调整并返回新文本（body: { plan, today?, at?, accepted? }）',
      'POST /plan/issues': '把校验问题渲染成可读文本',
    },
    docs: 'docs/测试指南.md',
  }));

  app.get('/health', async () => ({
    ok: true,
    schema: SCHEMA_ID,
    planFileName: PLAN_FILE_NAME,
    node: process.version,
    llm: provider ? { configured: true, provider: provider.name } : { configured: false },
  }));

  /** 只校验，不做任何计算。App 在保存前调用。 */
  app.post('/plan/validate', async (req, reply) => {
    const body = PlanText.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const r = readPlan(body.data.plan);
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error, issues: r.issues });
    return {
      ok: true,
      id: r.plan.id,
      version: r.plan.version,
      title: r.plan.meta.title,
      tasks: r.plan.tasks.length,
      warnings: r.warnings,
    };
  });

  /** 复盘：引擎算 + （可选）LLM 讲人话。这是移动端复盘页的唯一数据源。 */
  app.post('/plan/review', async (req, reply) => {
    const body = ReviewBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const r = readPlan(body.data.plan);
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error, issues: r.issues });

    const today = body.data.today ?? todayLocal();
    const report = reviewPlan(r.plan, today);

    let view: AdvisorView;
    let note: string;

    if (!provider || body.data.useLlm === false) {
      view = engineView(r.plan, report);
      note = provider ? '客户端要求降级' : '服务端未配置 LLM';
    } else {
      const res = await completeJson(provider, AdvisorOutput, buildAdvisorMessages(r.plan, report), { retries: 1 });
      if (!res.ok) {
        // 模型挂了不能让复盘功能跟着挂——这是产品要求，不是容错加分项
        view = engineView(r.plan, report);
        note = `模型调用失败（尝试 ${res.attempts} 次），已降级：${res.error}`;
        req.log.warn({ err: res.error }, 'advisor llm failed, degraded');
      } else {
        view = validateAdvisorOutput(res.value, r.plan, report);
        note = res.attempts > 1 ? `模型重试 ${res.attempts - 1} 次后通过` : 'ok';
        if (view.dropped.reasons || view.dropped.options) {
          req.log.warn({ dropped: view.dropped }, 'advisor output contained hallucinated references');
        }
      }
    }

    return {
      ok: true,
      today,
      version: r.plan.version,
      report,
      view,
      note,
      warnings: r.warnings,
    };
  });

  /** 应用调整：返回**新的文件文本**，由客户端落盘。 */
  app.post('/plan/apply', async (req, reply) => {
    const body = ApplyBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const r = readPlan(body.data.plan);
    if (!r.ok) return reply.code(400).send({ ok: false, error: r.error, issues: r.issues });

    const today = body.data.today ?? todayLocal();
    const report = reviewPlan(r.plan, today);
    if (!report.adjustments.length) {
      return { ok: true, plan: body.data.plan, version: r.plan.version, applied: 0, warnings: [] };
    }

    const at = body.data.at ?? nowStamp();
    if (at < r.plan.meta.updated) {
      // 并发保护：乱序写入会让版本号倒退。用 409 而不是 400——
      // 这不是「请求格式错」，而是「基于的状态已经旧了」，客户端应重新拉取。
      return reply.code(409).send({
        ok: false,
        error: `时间戳 ${at} 早于计划的 meta.updated（${r.plan.meta.updated}）`,
        currentVersion: r.plan.version,
      });
    }

    const accepted = body.data.accepted;
    const chosen = accepted
      ? report.adjustments.filter((a) => {
          switch (a.kind) {
            case 'reschedule':
            case 'estimate':
            case 'dropTask':
              return accepted.includes(a.taskId);
            case 'addTask':
              return accepted.includes(a.task.id);
            default:
              return false;
          }
        })
      : report.adjustments;

    if (!chosen.length) {
      return { ok: true, plan: body.data.plan, version: r.plan.version, applied: 0, warnings: [] };
    }

    const review: Review | undefined = body.data.review
      ? {
          at,
          plannedTasks: body.data.review.plannedTasks,
          completedTasks: body.data.review.completedTasks,
          loadFeedback: body.data.review.loadFeedback ?? null,
          notes: body.data.review.notes ?? '',
          adjustments: [],
        }
      : undefined;

    const written = applyCommand(r.plan, { type: 'plan.applyAdjustments', at, applied: chosen, review });
    if (!written.ok) {
      return reply.code(422).send({ ok: false, error: written.error });
    }

    return {
      ok: true,
      plan: serializePlan(written.plan),
      version: written.plan.version,
      applied: chosen.length,
      warnings: written.warnings,
    };
  });

  /** 供调试：把校验问题渲染成可读文本 */
  app.post('/plan/issues', async (req, reply) => {
    const body = PlanText.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ ok: false, error: '请求体不合法' });
    const r = parsePlan(body.data.plan);
    if (r.ok) return { ok: true, text: formatIssues(r.warnings) };
    return { ok: false, text: formatIssues(r.issues) };
  });
}
