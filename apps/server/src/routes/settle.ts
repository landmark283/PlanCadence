/**
 * `POST /plan/settle` —— 只做一件事：把引擎算好的补账事实**说成人话**。
 *
 * ## 它拿不到计划
 *
 * 请求体是 `SettleNarrativeInput`，里面只有「过了几天、几项没做、每项压了多久、
 * 挡着几个后继」这些已经算好的数字，**没有整份计划**。
 * 所以它在结构上就不可能重算一遍，也就不可能和界面上的清单对不上。
 *
 * ## 任何一步出问题都退回本机叙述
 *
 * 客户端会把 `settlePlanText(facts)` 的结果一并发上来（`localText`）。
 * 模型没配、调用失败、输出不合法、**或者写出了一个事实之外的数字**，
 * 都直接把 `localText` 原样返回。这一屏在断网时必须仍然可用，
 * 而且它显示的清单本来就来自本机——叙述降级不该让学生看到空白。
 */
import type { FastifyInstance } from 'fastify';
import {
  SettleNarrativeInput,
  SettleNarrativeOutput,
  buildSettleNarrativeMessages,
  narrativeNumbersOk,
} from '@sp/shared';
import { completeJson } from '@sp/llm-client';
import type { LlmProvider } from '@sp/llm-client';

export function registerSettleRoutes(app: FastifyInstance, provider: LlmProvider | null): void {
  app.post('/plan/settle', async (req, reply) => {
    const body = SettleNarrativeInput.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: '请求体不合法', issues: body.error.issues });
    }
    const input = body.data;

    const degraded = (note: string) => ({
      ok: true,
      narrative: input.localText,
      narrativeSource: 'local' as const,
      note,
    });

    if (!provider) return degraded('服务端未配置 LLM');

    const res = await completeJson(provider, SettleNarrativeOutput, buildSettleNarrativeMessages(input), {
      retries: 1,
    });
    if (!res.ok) {
      req.log.warn({ err: res.error }, 'settle narrative llm failed, degraded');
      return degraded(`模型调用失败（尝试 ${res.attempts} 次），已降级：${res.error}`);
    }

    /**
     * 数字白名单校验。这是把「引擎算事实、模型只改措辞」从一句口号
     * 变成真正约束的地方——模型把 9 项说成 3 项，学生无从发现，
     * 而他会因此对整个系统失去信任。宁可退掉一段写得不错的文字。
     */
    const check = narrativeNumbersOk(res.value.narrative, input);
    if (!check.ok) {
      req.log.warn({ bad: check.bad }, 'settle narrative invented numbers, degraded');
      return degraded(`模型写出了事实之外的数字（${check.bad.join('、')}），已退回本机措辞`);
    }

    return {
      ok: true,
      narrative: res.value.narrative,
      narrativeSource: 'llm' as const,
      note: res.attempts > 1 ? `模型重试 ${res.attempts - 1} 次后通过` : 'ok',
    };
  });
}
