/**
 * `POST /plan/talk` —— 学生说一句话，服务端回一张待确认卡。
 *
 * ## 和别的接口一样：文本进、文本出
 *
 * 计划原文由客户端发上来，服务端不持有状态。这一条在这个接口上尤其重要：
 * 「跟 AI 说说」是唯一**必须联网**的能力（自然语言理解本机做不到），
 * 所以它更不能依赖任何服务端内存里的东西。
 *
 * ## 这一条**没有本机兜底**，而且要说清楚
 *
 * 复盘断网时能完整走完（题目、建议、应用都是本机的）。这一条不行——
 * 硬要兜底就得写一个「只听得懂三句话」的关键词解析器，
 * 而学生试两次失败之后就不信它了，那比「明确说没连上」伤得多。
 *
 * 所以这里在**开工前**就把「不可用」说清楚：没配模型直接返回 `ok:false` 和
 * 一句人话，而不是等学生打完字再报错。
 *
 * ## 真正的把关在 `resolveTalkOutput`
 *
 * 提示词里的规则没有约束力。编出来的 id、算错的日期、以及「有问题却又给提案」
 * 都在那一层被处理掉——它是纯函数，所以有单测盯着（`llm/talk.test.ts`）。
 */
import type { FastifyInstance } from 'fastify';
import { TalkInput, TalkOutput, buildTalkMessages, clarifyRounds, parsePlan, resolveTalkOutput } from '@sp/shared';
import type { LearnerProfile } from '@sp/shared';
import { completeJson } from '@sp/llm-client';
import type { LlmProvider } from '@sp/llm-client';
import type { ServerClock } from '../clock.ts';

export function registerTalkRoutes(app: FastifyInstance, provider: LlmProvider | null, clock: ServerClock) {
  app.post('/plan/talk', async (req, reply) => {
    const body = TalkInput.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }

    const r = parsePlan(body.data.plan);
    if (!r.ok) {
      return reply.code(400).send({ ok: false, error: r.error, issues: r.issues });
    }

    /**
     * 没配模型：**现在就说不可以**。
     *
     * 这不是「降级」，是「这个能力需要联网」。返回一句学生看得懂的话，
     * 客户端据此显示空态和手动入口（改某一项 / 打开日历）。
     */
    if (!provider) {
      return { ok: false, unavailable: true, error: '服务端没有配置模型，这一条现在用不了' };
    }

    const today = body.data.today || clock.today();
    /**
     * 目标清单由**服务端**从计划原文里填。
     *
     * 客户端不用发它——服务端为了校验本来就要 `parsePlan` 一遍，
     * 而多目标之后「哪条线是哪条」是模型最容易搞错的地方（去改总截止日而不是
     * 那条线的截止日）。少一个客户端字段，就少一处两边对不上的可能。
     */
    const res = await completeJson(
      provider,
      TalkOutput,
      buildTalkMessages({
        ...body.data,
        milestones: r.plan.milestones.map((m) => ({ id: m.id, title: m.title, due: m.due })),
      }),
      { retries: 1 }
    );
    if (!res.ok) {
      // 模型挂了照实说。这一条没有本机兜底——假装在工作比报错更糟
      req.log.warn({ err: res.error }, 'talk llm failed');
      return reply.code(502).send({
        ok: false,
        unavailable: true,
        error: `模型没能回答（尝试 ${res.attempts} 次）：${res.error}`,
      });
    }

    const result = resolveTalkOutput(res.value, r.plan, today, {
      rounds: clarifyRounds(body.data.history),
    });
    if (result.dropped) {
      req.log.warn({ dropped: result.dropped }, 'talk output had entries that failed validation');
    }

    return {
      ok: true,
      today,
      version: r.plan.version,
      // 档案由客户端发上来、也只由客户端写回计划文件；服务端只是把它转给模型
      profile: body.data.profile as LearnerProfile | null,
      result,
      note: res.attempts > 1 ? `模型重试 ${res.attempts - 1} 次后通过` : 'ok',
    };
  });
}
