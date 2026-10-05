/**
 * 赛事日程的**实时**抓取。
 *
 * ## 为什么选 Codeforces
 *
 * 因为它是唯一一个**免费、公开、无需密钥、返回结构化 JSON** 的赛事来源。
 * 蓝桥杯 / CCPC / ICPC 都只有官网页面，没有可依赖的接口——
 * 想拿它们的日期就得爬页面，而爬页面在比赛现场断网或被改版时立刻失效，
 * 更糟的是**会让人忍不住"估一个日期填上去"**，那就是编数据。
 *
 * 所以分工是：
 *   · 有确切时间、能实时拿到的（Codeforces 赛程）→ 真的去拿，`source` 标成接口地址
 *   · 只有官网入口、date 拿不到的（蓝桥杯等）→ 只给官网链接，**deadline 留空**
 * 卡片上「今天校验 · 来自 codeforces.com/api」和「N 天前校验 · 来自 资料库快照」
 * 一眼就能区分，学生知道自己在看什么。
 *
 * ## 这个函数**一定会失败**，所以要设计成失败了也不难看
 *
 * 现场网络、接口限流、对方改字段，任何一样都能让它挂。所以它从不抛异常：
 * 成功返回赛事数组，失败返回空数组 + 一句人话原因。调用方拿空数组继续跑，
 * 结果退化成纯离线的那一套——赛事区只显示官网入口，其余功能完全不受影响。
 */
import { Resource, dayOf } from '@sp/shared';

/** Codeforces 接口地址。公开、无密钥 */
const API = 'https://codeforces.com/api/contest.list?gym=false';

export type ContestFetch = {
  contests: Resource[];
  /** 给界面看的来源标注。成功是接口地址，失败时说明为什么没有实时数据 */
  source: string;
  note: string;
};

type CfContest = {
  id?: number;
  name?: string;
  phase?: string;
  startTimeSeconds?: number;
  durationSeconds?: number;
};

export type FetchContestsOptions = {
  /** 最多返回几场。默认 4——面板上摆十几场只会让人不想看 */
  limit?: number;
  /** 单次请求超时，默认 8 秒。演示时不该为了它把生成卡住 */
  timeoutMs?: number;
  /** 便于测试注入 */
  fetchImpl?: typeof fetch;
  /**
   * 「现在」（epoch 毫秒）。不传就读真实时钟。
   *
   * ## 为什么它必须是参数，不能在这里写 `Date.now()`
   *
   * 这个文件以前直接读 `Date.now()`，而调用方同时把 App 的 `today` 传了进来——
   * 于是同一个请求里「今天」有**两个来源**，而它们真的打过架：
   * 演示时钟是 2026-10-19，真实的「即将开赛」却按 2026-10-04 过滤，
   * 结果抓回来的每一场在界面上都显示成「已截止 12 天」。
   *
   * 当时的处理是在标题里保留日期、抑制倒计时——那是绕过。
   * 现在时间统一由服务端时钟给（`SP_TODAY` 冻结时这里也一起冻结），
   * 两个来源变成同一个，这个矛盾就不存在了。
   */
  nowMs?: number;
  /**
   * App 认为的「今天」。
   *
   * ## 它只用来决定**要不要给倒计时**，不用来决定「哪些算未来」
   *
   * 「还没开赛」必须按上面那个 `nowMs` 判断——一个实时接口返回的
   * 「即将开始」，意思就是相对那个时刻即将开始。
   *
   * 但倒计时是拿 `today` 算的（`daysBetween(today, deadline)`）。
   * 正常模式下 `today` 和 `nowMs` 都来自服务端时钟，两者一致；
   * 只有在调试模式把客户端日期调得和服务端不一样时才会分叉，
   * 这时候宁可不给倒计时（标题里的日期照旧），也不要显示一个会误导人的负数。
   */
  today?: string;
  /** 算「开赛是哪一天」用的时区偏移。不传按东八区 */
  offsetMinutes?: number;
};

/**
 * 取接下来几场 Codeforces 比赛。
 *
 * 只取 `phase === 'BEFORE'` 的场次：已经打完的比赛挂在一份"学习计划"上
 * 只会让学生困惑。`gym=false` 也同理——gym 里是一次性的训练赛，不是赛程。
 */
export async function fetchCodeforcesContests(opts: FetchContestsOptions = {}): Promise<ContestFetch> {
  const limit = opts.limit ?? 4;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const nowMs = opts.nowMs ?? Date.now();
  const offset = opts.offsetMinutes ?? 480;
  const today = opts.today ?? dayOf(nowMs, offset);

  try {
    const res = await doFetch(API, {
      // 这里用 `AbortSignal.timeout` 是安全的：**这段代码只跑在 Node 上**。
      // `@sp/llm-client` 里之所以手写 setTimeout，是因为那一层要和移动端共享，
      // 而 Hermes 不保证有这个方法。别照着那边"修"这里
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      return { contests: [], source: 'codeforces.com/api', note: `赛事接口返回 HTTP ${res.status}` };
    }

    const body = (await res.json()) as { status?: string; result?: CfContest[] };
    if (body.status !== 'OK' || !Array.isArray(body.result)) {
      return { contests: [], source: 'codeforces.com/api', note: '赛事接口返回了预期之外的结构' };
    }

    const upcoming = body.result
      .filter((c) => c.phase === 'BEFORE' && typeof c.id === 'number' && typeof c.startTimeSeconds === 'number')
      // 按**同一个时钟**过滤「还没开赛」。以前这里读真实的 Date.now()，
      // 和调用方传进来的 today 是两个来源，演示时必然打架
      .filter((c) => c.startTimeSeconds! * 1000 >= nowMs)
      // 按开赛时间从近到远
      .sort((a, b) => a.startTimeSeconds! - b.startTimeSeconds!)
      .slice(0, limit);

    if (!upcoming.length) {
      return { contests: [], source: 'codeforces.com/api', note: '接口里没有即将开始的场次' };
    }

    const verifiedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const contests = upcoming.map((c) => {
      // 用服务端时区算「开赛是哪一天」，不用 toISOString().slice(0,10)——
      // 那是 UTC 的日期，东八区晚上开赛的场次会被算到前一天
      const day = dayOf(c.startTimeSeconds! * 1000, offset);
      // 开赛日早于 App 认定的今天就不给 deadline，见 FetchContestsOptions.today
      const countdownOk = day >= today;
      return Resource.parse({
        id: `res_cf_${c.id}`,
        title: `${c.name ?? `Codeforces #${c.id}`} · ${day} 开赛`,
        url: `https://codeforces.com/contest/${c.id}`,
        kind: 'contest',
        verifiedAt,
        // 这个字符串要和 `@sp/shared` 的 `LIVE_SOURCES` 对得上——
        // 界面靠它把「刚抓的」标成实时
        source: 'codeforces.com/api',
        // 开赛之后就不能再参加了，所以"截止"就是开赛日。
        // 卡片上显示成「还有 N 天截止」——语义上略糙，但比没有倒计时有用得多
        deadline: countdownOk ? day : null,
      });
    });

    const noCountdown = contests.filter((c) => c.deadline === null).length;
    const tail = noCountdown ? `（其中 ${noCountdown} 场开赛日早于当前演示日期，只显示日期不给倒计时）` : '';
    return { contests, source: 'codeforces.com/api', note: `实时取得 ${contests.length} 场${tail}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { contests: [], source: 'codeforces.com/api', note: `赛事接口不可用（${msg}），本轮只用本地资料库` };
  }
}
