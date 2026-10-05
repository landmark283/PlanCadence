/**
 * 访谈与生成的 HTTP 端点。
 *
 * ## 两个端点，同一个原则
 *
 * `POST /interview/next` 和 `POST /plan/draft` 都是**「模型只负责发挥，兜底永远在场」**：
 * 先在本地把确定性的结果算出来，再让模型去改进它；模型不可用、超时、
 * 或者输出不合格时，回退到本地结果并**把降级原因如实返回**（`note` + `source`）。
 *
 * 这不是容错加分项，是产品要求：学生不能因为「今天网络不好」就做不了访谈、
 * 或者拿到一份过不了校验的计划。
 *
 * ## 恢复轮为什么不重生成
 *
 * `planner.draft` 的 LLM 输出要过 `validatePlan`。失败时把**具体报错**
 * 附回提示词让它定点修复，最多 2 轮。整份重生成会把已经正确的部分一起摇掉——
 * 实测下来，改 3 个悬空引用比重写 25 个任务稳定一个数量级。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DraftOutput,
  InterviewOutput,
  LearnerProfile,
  MAX_QUESTIONS,
  QuestionSpec,
  assemblePlan,
  buildInterviewMessages,
  buildPlannerMessages,
  describePlanDraft,
  localDraft,
  missingProfileFields,
  nextLocalQuestion,
  parseDraftOutput,
  serializePlan,
  validateInterviewQuestion,
  withToolResources,
} from '@sp/shared';
import { completeJson } from '@sp/llm-client';
import type { LlmProvider } from '@sp/llm-client';
import type { ServerClock } from '../clock.ts';
import { fetchCodeforcesContests } from '../tools/codeforces.ts';

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD');
const StampStr = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/, '时间戳必须是 ISO 8601');
const ShortId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'id 必须是小写字母开头');

/** 定点修复最多几轮。再多就是模型确实做不了这件事，不如直接用本地兜底 */
const MAX_REPAIR_ROUNDS = 2;

const NextBody = z.object({
  profile: LearnerProfile,
  asked: z.array(QuestionSpec).max(MAX_QUESTIONS),
  /** false 时强制走本地题库，便于客户端在弱网下主动降级 */
  useLlm: z.boolean().optional(),
});

const DraftBody = z.object({
  profile: LearnerProfile,
  today: DateStr.optional(),
  at: StampStr.optional(),
  id: ShortId.optional(),
  title: z.string().min(1).max(120).optional(),
  useLlm: z.boolean().optional(),
});

export function registerInterviewRoutes(
  app: FastifyInstance,
  provider: LlmProvider | null,
  clock: ServerClock,
): void {
  /**
   * 出下一题。
   *
   * 注意：**模型说 done 不一定真的够**。见过模型问两题就收工，
   * 而档案里连截止日都还没有——那样生成出来的计划没法倒排。
   * 所以关键信息缺太多时，即使模型喊停也继续用本地题库补问。
   */
  app.post('/interview/next', async (req, reply) => {
    const body = NextBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const { profile, asked } = body.data;
    const local = nextLocalQuestion(asked);
    const finishLocal = (note: string) => ({
      ok: true as const,
      done: !local,
      question: local,
      source: 'local' as const,
      note,
      missing: missingProfileFields(profile),
    });

    if (!provider || body.data.useLlm === false) {
      return finishLocal(provider ? '客户端要求降级' : '服务端未配置 LLM');
    }

    const res = await completeJson(provider, InterviewOutput, buildInterviewMessages(profile, asked), { retries: 1 });
    if (!res.ok) {
      req.log.warn({ err: res.error }, 'interview llm failed, degraded');
      return finishLocal(`模型调用失败（尝试 ${res.attempts} 次），已回退到本地题库：${res.error}`);
    }

    if (res.value.done) {
      const missing = missingProfileFields(profile);
      // 模型喊停但关键信息还缺一半以上 —— 不认，用本地题继续补
      if (missing.length > 2 && local) {
        return { ...finishLocal(`模型认为可以结束了，但还缺 ${missing.join('、')}，继续补问`), done: false };
      }
      return {
        ok: true as const,
        done: true,
        question: null,
        source: 'llm' as const,
        note: 'ok',
        missing,
      };
    }

    const q = validateInterviewQuestion(res.value, profile, asked);
    if (!q) {
      return finishLocal('模型出的题目不合格（重复 / 选项不足 / 字段缺失），已回退到本地题库');
    }

    return {
      ok: true as const,
      done: false,
      question: q,
      source: 'llm' as const,
      note: res.attempts > 1 ? `模型重试 ${res.attempts - 1} 次后通过` : 'ok',
      missing: missingProfileFields(profile),
    };
  });

  /**
   * 由档案生成计划，返回**新的文件文本**。
   *
   * LLM 路径：生成 → 组装 → 过 validatePlan → 不过就把具体报错回灌做定点修复（≤2 轮）
   * → 仍然不过或调用失败 → 本地兜底。
   */
  app.post('/plan/draft', async (req, reply) => {
    const body = DraftBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const { profile } = body.data;
    const today = body.data.today ?? clock.today();
    const at = body.data.at ?? clock.nowStamp();
    const id = body.data.id ?? `plan_${Date.now().toString(36)}`;
    const title = body.data.title ?? (profile.goalStatement ? profile.goalStatement.slice(0, 40) : '学习计划');

    /**
     * 工具调用：把资料挂进草稿。
     *
     * 放在 `emit` 之前而不是之后，是因为 `validatePlan` 要检查
     * `task.resourceIds` 的引用完整性——先挂好再组装，校验一次就够了。
     *
     * 实时赛事抓取失败**不影响生成**：`fetchCodeforcesContests` 从不抛异常，
     * 拿不到就返回空数组，结果退化成纯离线的那一套。
     * 演示现场断网时计划照样出得来，只是赛事区只剩官网入口。
     */
    let liveContests: Awaited<ReturnType<typeof fetchCodeforcesContests>> = {
      contests: [],
      source: 'codeforces.com/api',
      note: '客户端要求降级，未抓取赛事',
    };
    if (body.data.useLlm !== false) {
      liveContests = await fetchCodeforcesContests({
        nowMs: clock.nowMs(),
        today,
        offsetMinutes: clock.offsetMinutes(),
      });
    }

    const attach = (draft: Parameters<typeof withToolResources>[0]) => {
      const r = withToolResources(draft, profile, liveContests.contests);
      const extra: string[] = [];
      if (r.draft.resources.length) extra.push(`${r.draft.resources.length} 条资料`);
      if (r.droppedModelResources > 0) {
        // 丢掉模型编的资源这件事必须说出来，不能悄悄删
        extra.push(`替换掉模型自己写的 ${r.droppedModelResources} 条资源（网址未经验证）`);
      }
      if (liveContests.contests.length) extra.push(`实时赛事 ${liveContests.contests.length} 场`);
      return { draft: r.draft, tail: extra.length ? ` · ${extra.join(' · ')}` : '' };
    };

    /** 组装 + 返回。组装失败是 422：请求本身没错，是草稿内容不合法 */
    const emit = (draft: Parameters<typeof assemblePlan>[0], source: 'llm' | 'local', note: string, repaired: number) => {
      const assembled = assemblePlan(draft, { id, now: at, title, profile });
      if (!assembled.ok) {
        return reply.code(422).send({
          ok: false,
          error: assembled.error,
          issues: assembled.issues,
          source,
          note,
        });
      }
      return {
        ok: true as const,
        plan: serializePlan(assembled.plan),
        version: assembled.plan.version,
        source,
        repaired,
        note,
        summary: describePlanDraft(assembled.plan),
        warnings: assembled.issues,
      };
    };

    const fallback = (note: string, repaired = 0) => {
      const a = attach(localDraft(profile, today));
      return emit(a.draft, 'local', note + a.tail, repaired);
    };

    if (!provider || body.data.useLlm === false) {
      return fallback(provider ? '客户端要求降级' : '服务端未配置 LLM，使用本地生成');
    }

    let errors: string[] = [];
    for (let round = 0; round <= MAX_REPAIR_ROUNDS; round++) {
      const res = await completeJson(
        provider,
        DraftOutput,
        buildPlannerMessages(profile, today, errors.length ? { errors } : undefined),
        { retries: 1 },
      );

      if (!res.ok) {
        req.log.warn({ err: res.error, round }, 'planner llm failed, degraded');
        return fallback(`模型调用失败（第 ${round + 1} 轮，尝试 ${res.attempts} 次），已改用本地生成：${res.error}`, round);
      }

      // completeJson 已经按 DraftOutput 校验过结构，这里只需再验语义（引用完整性等）
      const parsed = parseDraftOutput(res.value);
      if (!parsed.ok) {
        errors = [parsed.error];
        continue;
      }

      // 先挂资料再组装：`resourceIds` 的引用完整性由 validatePlan 检查，
      // 挂完再组装只需要校验一次
      const withTools = attach(parsed.draft);
      const assembled = assemblePlan(withTools.draft, { id, now: at, title, profile });
      if (assembled.ok) {
        const base = round > 0 ? `模型经 ${round} 轮定点修复后通过校验` : 'ok';
        return emit(withTools.draft, 'llm', base + withTools.tail, round);
      }

      const errs = assembled.issues.filter((i) => i.level === 'error').map((i) => `${i.path}: ${i.message}`);
      req.log.warn({ round, errors: errs }, 'planner draft failed validation, requesting targeted repair');
      errors = errs;
    }

    return fallback(`模型 ${MAX_REPAIR_ROUNDS} 轮定点修复后仍不合校验，已改用本地生成（最后的问题：${errors[0] ?? '未知'}）`, MAX_REPAIR_ROUNDS);
  });
}
