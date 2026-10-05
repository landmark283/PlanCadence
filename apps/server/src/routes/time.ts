/**
 * `GET /time` —— 全服务唯一的「现在是几点、今天是哪天」。
 *
 * ## 为什么客户端不自己算「今天」
 *
 * `toISOString().slice(0, 10)` 是 UTC 的日期，东八区晚上 8 点之后会算成「明天」。
 * 这个错误在服务端只可能犯一次（就是这里），在客户端会犯很多次。
 * 所以日期在这里算好再给。
 *
 * ## 为什么 `nowUtc` 和 `offsetMinutes` 分开给
 *
 * 不给一个 `+08:00` 字符串，是因为客户端要**手工格式化**它
 * （把偏移加到 epoch 毫秒上再取各字段），而解析字符串会引入一个正则。
 * 分开给之后客户端一个时区库都不需要碰——Hermes 是否带 `Intl` 取决于构建配置，
 * 不能让「今天是哪天」悬在一个可能不存在的 API 上。
 *
 * `zone` 只用于显示，客户端不拿它做计算。
 */
import type { FastifyInstance } from 'fastify';
import type { ServerClock } from '../clock.ts';

export function registerTimeRoutes(app: FastifyInstance, clock: ServerClock): void {
  app.get('/time', async () => ({
    ok: true,
    nowUtc: clock.nowUtc(),
    nowStamp: clock.nowStamp(),
    offsetMinutes: clock.offsetMinutes(),
    today: clock.today(),
    zone: clock.zone,
    /** 非 null 表示这台服务端的时间被 `SP_TODAY` 冻结了。界面要如实告诉学生 */
    frozen: clock.frozen,
  }));
}
