/**
 * 计划状态 —— 前端唯一允许改动计划的地方。
 *
 * 铁律（来自 commands.ts）：任何状态变更都必须走 `applyCommand`，
 * 组件里不许直接改 plan 对象。所以这里把 `applyCommand` 包成一个 store，
 * 界面拿到的永远是新的、已校验过的 plan。
 *
 * ## 落盘
 *
 * 每次成功变更都会写回设备上的 `.studyplan` 文件，并留下上一版的整份快照。
 * 判断「有没有未落盘的改动」用的是**单调递增的修订号**而不是版本号：
 * 重新生成计划时版本号会回到 v1，用版本号判断会导致「v1 → v1」这种改动
 * 被当成没事发生。
 *
 * ## 读不出来时不许覆盖
 *
 * 格式对外的承诺是「可读、可手改」。所以如果设备上的文件解析失败，
 * 我们**不写盘**——那多半是学生手改时敲错了，直接覆盖就把他的编辑抹掉了。
 * 此时界面会明确说明，并给一个「用当前计划覆盖文件」的显式按钮。
 *
 * ## 读不出来有两种，不能混成一句话
 *
 * 「文件内容不合法」和「存储本身用不了」会走到同一个 catch 里，但处理方式相反：
 * 前者要给一个覆盖按钮，后者给了也没用（写不进去），该给的是重试。
 * 所以 `loadError` 带 `kind`。
 *
 * ## 写下去之后要读回来核对
 *
 * `planText` 的定义是「**设备上那份文件的原文**」。如果写入后直接把它设成
 * 刚序列化出来的字符串，这个定义就是假的——写盘静默失效时界面照样显示
 * 「已保存到设备」，而设备上什么都没有。所以每次写完都重新读一遍，
 * 读回来的东西和写下去的**不一致就报错**。
 *
 * ## 为什么 `at` 在 dispatch 之前取
 *
 * reducer 必须是纯函数（StrictMode 下会被调两次），时钟读数放进 reducer
 * 会让两次调用产生不同的时间戳。
 *
 * ## 时钟与补账
 *
 * 「今天是哪天」不再是一个写死的常量，而是来自 `state/clock.ts`：
 * 调试模式用设置里的日期，正常模式问服务端。这里负责在启动和回到前台时
 * 把基准接上，并在启动时判断**要不要结账**（隔了 ≥1 天没打开）。
 *
 * 设置（调试开关、上次打开）存在设备上的 `settings.json`，**不进计划文件**；
 * 而**学生档案进计划文件**——它是关于这个学生的，不是关于这台设备的。
 *
 * ## 会话（复盘 / 跟 AI 说说）
 *
 * 待确认的提案活在 store 里，不在某一屏的 `useState` 里：因为「编辑一张建议卡」
 * 要跨屏（进编辑页改完再回来），放在页面里那次跳转就把它丢了。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import {
  DEFAULT_SETTINGS,
  addDays,
  allocateIds,
  answerTurn,
  applyCommand,
  daysBetween,
  parsePlan,
  parseSettings,
  proposalKey,
  readProfile,
  readingOf,
  reviewDirection,
  reviewPlan,
  reviewProposals,
  reviewQuestions,
  saveWithSnapshot,
  serializePlan,
  serializeSettings,
  settleFacts,
  settleNarrativeInput,
  settlePlanText,
  toAppliedAdjustment,
  withProfile,
  type Answer,
  type AppSettings,
  type ClockBase,
  type ClockSetting,
  type ClockSource,
  type Command,
  type LearnerProfile,
  type PlanFile,
  type Proposal,
  type QuestionSpec,
  type SettleCarry,
  type SettleFacts,
  type TalkTurn,
} from '@sp/shared';

import { DEMO_PLAN_TEXT } from '@/fixtures/demo-plan';
import { fetchSettleNarrative, fetchServerTime, fetchTalk } from '@/lib/api';
import { baseFromDevice, baseFromSetting, baseFromTime, nextStamp, reading, setBase } from '@/state/clock';
import {
  appSettingsStorage,
  planStorage,
  storageBackend,
  storageHint,
  storageRoot,
} from '@/storage/plan-storage';

/** 计划 id。生成新计划时保持不变，版本快照才对得上 */
export const PLAN_ID = 'plan_czw01';

/**
 * 去掉 `at` 的命令类型。
 *
 * 必须用分配式 Omit：直接写 `Omit<Command, 'at'>` 会把联合类型折叠成
 * 各成员**公共键**的集合，判别联合就此失效，传 `taskId` 会报不存在的属性。
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PlanCommand = DistributiveOmit<Command, 'at'>;

/** 操作反馈。命令层的拒绝理由要让学生看见，不能静默吞掉 */
export type Notice = {
  tone: 'error' | 'success';
  text: string;
};

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error' | 'blocked';

/**
 * 读文件失败的原因分类。
 *
 * `parse` 是文件内容的问题（多半是手改敲错了，能改回来）；
 * `io` 是存储本身的问题（读不到、写不进，改文件没用）。
 */
export type LoadFailure = {
  kind: 'parse' | 'io';
  message: string;
};

/**
 * 一次复盘（或一次「跟 AI 说说」）的会话。
 *
 * ## 为什么它必须活在 store 里，而不是复盘页的 `useState`
 *
 * 因为**编辑一张建议卡要跨屏**：学生点〔编辑〕进编辑页、改完返回。
 * 提案放在页面里的话，那次跳转就把它弄丢了。
 *
 * ## 为什么保留 `origin`
 *
 * 「这条你改过」这个标记需要它。没有它就只能显示改后的样子，
 * 而学生回头看不出自己动过哪里——而「我只改了几个字」正是这一屏的卖点。
 *
 * ## 为什么划掉的存键而不是从数组里删
 *
 * 学生后悔了要能勾回来。删了就没了。
 */
export type ProposalSession = {
  source: 'review' | 'talk';
  /** 计划修改的大体方向（复盘），或「我听懂了什么」（协商） */
  direction: string;
  /** 待确认的提案。**唯一的一份**——学生改过的也在这里 */
  proposals: Proposal[];
  /** 引擎/AI 最初给的，用来比出「你改过哪几条」 */
  origin: Proposal[];
  /** 被划掉的键 */
  dropped: string[];
  /** 复盘的条件问题。没有问题时是空数组，界面上整块不出现 */
  questions: QuestionSpec[];
  answers: Record<string, Answer>;
  /** 模型明说做不到的事 */
  refusals: string[];
  /**
   * 「跟 AI 说说」的对话轮次。**这是那一侧唯一的口语状态**——
   * 学生的话、AI 的复述与问题、学生对问题的回答全在里面。
   * 复盘会话里是空数组。
   */
  history: TalkTurn[];
  /**
   * 这一条现在用不了时的原因（没连上 / 没配模型）。
   *
   * 它和 `refusals` 分开：`refusals` 是「模型能做但这件事不在它范围内」，
   * 而这是「这次根本没问成」。界面处理方式不同——前者是一张说明卡，
   * 后者是一屏空态加手动入口。
   */
  unavailable: string | null;
};

type State = {
  plan: PlanFile | null;
  /** 文件本身就读不出来时的错误，和「某条命令被拒」是两回事 */
  loadError: LoadFailure | null;
  notice: Notice | null;
  /**
   * 这里曾经有一个 `warnings: string[]`——**删掉了**。
   *
   * 它在 `apply` / `installPlan` 里被填上，但从来没有任何界面读它；
   * 复盘页是直接对 `plan` 重新跑 `validatePlan` 拿警告的。
   * 同一件事算两遍、其中一份没人用，是纯粹的分歧风险。
   */
  /**
   * 学生档案（几年级、什么水平、每周多少时间、哪儿弱）。
   *
   * **它是计划文件的一部分**（`plan.profile`），这里只是它的一份镜像，
   * 方便界面直接读。改它要走 `plan.applyAdjustments` 的 `profile` 分支。
   */
  profile: LearnerProfile | null;
  /** 计划内容的修订号。每次成功变更 +1 */
  planRev: number;
  /** **设备上那份文件的文本**（不是内存里的），文件页要原样显示它 */
  planText: string;
  save: { status: SaveStatus; message: string | null };
  storageReady: boolean;
  /** 点「重试」时 +1，用来重新触发读取 effect */
  reloadToken: number;

  /* ── 时钟与补账 ─────────────────────────────────────── */
  /** 全 App 唯一的「今天是哪天」。来自时钟读数，不是常量 */
  today: string;
  /** 这个日期是谁给的（设置 / 服务端 / 本机）。界面要如实显示 */
  clockSource: ClockSource;
  /** 时钟设置。文件页要显示和修改它 */
  clockSetting: ClockSetting;
  /** 设备上的应用设置。补账判定要用 `lastSeen` */
  settings: AppSettings;
  /** 待处理的补账。非空时今日页会把学生送进结账页 */
  pendingSettle: SettleFacts | null;

  /** 正在进行的复盘 / 协商会话。null = 没有 */
  session: ProposalSession | null;
  /**
   * 「应用这次会话之前」的那份计划。非 null 时通知条上显示〔撤销〕。
   *
   * **它的有效期就是那条通知的有效期**：任何一次新的 `apply` 都会把它清掉
   * （见 reducer 的 `apply` 分支），所以它只对**紧接着的那一次**动作负责。
   *
   * 为什么用整份快照而不是反向命令：删任务的反向要恢复任务数据和别人的前置引用，
   * 中间任何一处漏了都会留下一个不一致的计划；而 `plan.restore` 是现成的、
   * 有测试的纯函数。这不是版本管理——它一次只留一份，而且活不过下一次改动。
   */
  undoSnapshot: PlanFile | null;
};

type Action =
  | { kind: 'apply'; cmd: Command }
  | { kind: 'dismissNotice' }
  /** 直接放一条通知。给「正在检索…」这类不属于任何命令的反馈用 */
  | { kind: 'notify'; notice: Notice | null }
  /**
   * 装入一份新生成的计划文本（替换当前计划）。
   *
   * `profile` 一并写进计划文件——这样「生成计划」只需要**一次写盘**。
   * 分两步（装计划 + 单独写档案）会得到两个版本，而且中间失败会留下
   * 「有计划、没档案」的状态，而那正好是「它不记得我说过的话」。
   */
  | { kind: 'installPlan'; text: string; note: string; expectRev?: number; profile?: LearnerProfile | null }
  | { kind: 'hydrate'; plan: PlanFile; planText: string }
  | { kind: 'seeded'; planText: string }
  | { kind: 'loadFailed'; failure: LoadFailure }
  | { kind: 'retryLoad' }
  | { kind: 'storageReady' }
  | { kind: 'saveStatus'; save: State['save'] }
  | { kind: 'saved'; planText: string }
  /** 解除「不许覆盖」的封锁，让当前计划写盘 */
  | { kind: 'unblock' }
  /* ── 时钟与补账 ─────────────────────────────────────── */
  | { kind: 'clock'; today: string; source: ClockSource; setting: ClockSetting; settings: AppSettings }
  | { kind: 'settleDue'; facts: SettleFacts }
  | { kind: 'settleDone' }
  /** 只更新设置（例如记下 lastSeen），不动时钟 */
  | { kind: 'settings'; settings: AppSettings }
  /* ── 复盘 / 协商会话 ────────────────────────────────── */
  | { kind: 'session'; session: ProposalSession | null }
  /** 记下「应用之前」的那份计划，让通知条上出现〔撤销〕 */
  | { kind: 'undoable'; snapshot: PlanFile };

function init(): State {
  const r = parsePlan(DEMO_PLAN_TEXT);
  return {
    // 内存里先放一份示例，界面在读取设备文件期间就有东西可渲染
    plan: r.ok ? r.plan : null,
    planText: '',
    planRev: 0,
    // 内置示例解析不了属于程序缺陷，不是学生操作出来的，所以归到 io 一类：
    // 这时候给他一个「覆盖文件」的按钮没有意义
    loadError: r.ok ? null : { kind: 'io', message: `内置示例计划无法解析：${r.error}` },
    notice: null,
    profile: null,
    save: { status: 'idle', message: null },
    storageReady: false,
    reloadToken: 0,
    // 时钟读数就绪之前先显示设备时间。放一个写死的演示日期会让首屏
    // 显示一个和学生对不上的日期，而它还会在几百毫秒后被换掉——那是闪一下假数据
    today: reading().today,
    clockSource: 'device',
    clockSetting: DEFAULT_SETTINGS.clock,
    settings: DEFAULT_SETTINGS,
    pendingSettle: null,
    session: null,
    undoSnapshot: null,
  };
}

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case 'apply': {
      if (!state.plan) return state;
      const res = applyCommand(state.plan, action.cmd);
      if (!res.ok) return { ...state, notice: { tone: 'error', text: res.error } };
      // 摘要由 commands.ts 生成，这里不自己拼——否则同一件事有两个说法
      const summary = res.plan.history.at(-1)?.summary ?? '已更新';
      return {
        ...state,
        plan: res.plan,
        /**
         * 档案镜像**从计划里重新读**，而不是「原样留着」。
         *
         * 档案就在计划文件里（`plan.profile`），所以任何一条命令都可能改到它——
         * `plan.applyAdjustments` 的 `profile` 分支正是干这个的（「我每周只有 3 小时了」
         * 改的不只是数字，还有他亲口说过的情况）。如果这里把旧镜像留着，
         * 计划文件已经变了而界面还显示旧的：文件页上写的和文件正文对不上，
         * 下一次「跟 AI 说说」也拿着过期的档案去回话。
         *
         * 一次 `safeParse` 的代价，换掉一整类「两份真相」的漂移，划算。
         */
        profile: readProfile(res.plan),
        planRev: state.planRev + 1,
        notice: { tone: 'success', text: summary },
        /**
         * **任何一次新的改动都会让上一次的撤销消失。**
         *
         * 这一行就是「撤销只活到下一次改动之前」的全部实现：
         * 快照恢复是整份替换，如果留着旧的快照，学生就会把中间那次改动
         * 一起撤掉——那不是他要的。
         */
        undoSnapshot: null,
      };
    }

    case 'dismissNotice':
      return { ...state, notice: null };

    case 'notify':
      return { ...state, notice: action.notice };

    case 'undoable':
      return { ...state, undoSnapshot: action.snapshot };

    case 'installPlan': {
      // 装进来的可能是服务端生成的、也可能是本机生成的文本。
      // 无论哪种都**必须在这里重新解析一遍**再进状态——
      // 一份解析不了的文本如果进了 store，会在每一屏各炸一次。
      const r = parsePlan(action.text);
      if (!r.ok) return { ...state, notice: { tone: 'error', text: `生成的计划无法解析：${r.error}` } };
      /**
       * 并发检查：生成一份计划要 20–40 秒。如果学生在这段时间里打了勾、
       * 改了时长，直接装进去会**静默覆盖**掉那些修改，而且不提示。
       *
       * 这才是真正需要防的乱序写（`applyCommand` 里那条按墙上时钟判断的守卫
       * 从来没保护过这里——`installPlan` 根本不经过命令层）。
       */
      if (action.expectRev !== undefined && action.expectRev !== state.planRev) {
        return {
          ...state,
          notice: {
            tone: 'error',
            text: '生成计划的这段时间里你改了计划。为避免覆盖你的修改，这次生成的结果没有装入——可以再来一次。',
          },
        };
      }
      /**
       * 档案和计划**一起**装进去。
       *
       * 新生成的计划文本里没有档案（模型不产它），所以要把刚访谈出来的那份写进来——
       * 否则下一次启动 `readProfile` 读到的还是旧的（或者空的），
       * 表现就是「刚做完访谈，它却不知道我是谁」。
       */
      const nextPlan = action.profile !== undefined ? withProfile(r.plan, action.profile) : r.plan;
      return {
        ...state,
        plan: nextPlan,
        /**
         * 档案镜像跟着**装进来的这份计划**走：不传 `profile` 不等于「保持原样」，
         * 而是「这份新文件里写了什么就是什么」。
         *
         * 反例很具体：磁盘上的示例文件本来就带档案，从文件页一按「重置为示例计划」，
         * 计划里明明有档案，镜像却还留着上一份（甚至是 null），
         * 于是文件页显示「还没有档案」，而它正下方那坨文件正文里就写着档案。
         */
        profile: readProfile(nextPlan),
        planRev: state.planRev + 1,
        loadError: null,
        notice: { tone: 'success', text: action.note },
      };
    }

    case 'hydrate':
      // 从设备读回来的就是已落盘状态，修订号归零，effect 不会立刻又写一遍。
      // 保存状态也要一并置为「已保存」——否则文件页会显示「尚未写入」，
      // 而磁盘上明明躺着这份文件。
      return {
        ...state,
        plan: action.plan,
        planText: action.planText,
        planRev: 0,
        loadError: null,
        save: { status: 'saved', message: null },
        /**
         * 档案从**计划文件**里读回来——这就是「重开 App 它还记得你是谁」。
         * `readProfile` 读不出来就给 null（结构不对的那份当没有），不抛。
         */
        profile: readProfile(action.plan),
      };

    case 'seeded':
      // 首次运行刚把初始计划写下去，同样算已保存
      return {
        ...state,
        planText: action.planText,
        planRev: 0,
        save: { status: 'saved', message: null },
      };

    case 'loadFailed':
      return {
        ...state,
        loadError: action.failure,
        // 只有「文件内容不合法」才暂停写入。存储本身坏掉时暂停没有意义——
        // 写入本来就不会成功，而且一旦恢复（换了后端、权限回来了）我们还想它能自己好
        save:
          action.failure.kind === 'parse'
            ? { status: 'blocked', message: action.failure.message }
            : { status: 'error', message: action.failure.message },
      };

    case 'retryLoad':
      return { ...state, reloadToken: state.reloadToken + 1 };

    case 'storageReady':
      return { ...state, storageReady: true };

    case 'saveStatus':
      return { ...state, save: action.save };

    case 'saved':
      return { ...state, planText: action.planText, save: { status: 'saved', message: null } };

    case 'unblock':
      return { ...state, loadError: null, planRev: state.planRev + 1, save: { status: 'idle', message: null } };

    case 'clock':
      return {
        ...state,
        today: action.today,
        clockSource: action.source,
        clockSetting: action.setting,
        settings: action.settings,
      };

    case 'settings':
      return { ...state, settings: action.settings, clockSetting: action.settings.clock };

    case 'settleDue':
      return { ...state, pendingSettle: action.facts };

    case 'settleDone':
      return { ...state, pendingSettle: null };

    case 'session':
      return { ...state, session: action.session };
  }
}

type Store = State & {
  /**
   * 应用一条命令。
   *
   * `at` 默认现取；需要让**别的字段和命令本身用同一个逻辑时刻**时（补账的
   * `review.at` 就是这种情况）由调用方传进来。多取一次会得到相差一分钟的两个
   * 时间戳，虽然不影响任何判断，但读历史的人会以为那是两件事。
   */
  apply: (cmd: PlanCommand, at?: string) => void;
  dismissNotice: () => void;
  /**
   * 放一条不属于任何命令的通知。
   *
   * 「正在检索资料…」这种进度反馈需要一个出口：它既不是命令的摘要，
   * 也不该为了显示它去造一条假命令。传 null 就是清掉。
   */
  notify: (notice: Notice | null) => void;
  /** 装入一份新生成的计划文本（替换当前计划）。`profile` 会一并写进计划文件 */
  installPlan: (text: string, note: string, expectRev?: number, profile?: LearnerProfile | null) => void;
  /** 设备上的文件读不出来时，用当前内存里的计划覆盖它 */
  forceOverwrite: () => void;
  /** 存储出错后重新读一次（改了权限、换了后端、修好了文件都能靠它恢复） */
  retryLoad: () => void;
  /**
   * 演示口径的今天。所有界面统一从 store 取，避免各页各写一个常量。
   *
   * 它现在是一个会变的值（调试模式下由设置决定，正常模式下由服务端决定），
   * 但**取法没变**——各页仍然是 `const { today } = usePlanStore()`。
   */
  today: string;
  /**
   * **真实的**今天（按设备时钟算）。
   *
   * 它和 `today` 只在调试模式下不一样，而那个差别很关键：
   * 学生把日期固定到 10 月 19 日之后，「今天」这个快捷档位如果读的是 `today`，
   * 它就会把日期设成 10 月 19 日——一个原地打转的空操作。
   * 「回到今天」的意思必须是回到真的今天。
   */
  realToday: string;
  /** 换一个时钟设置并立刻生效。文件页改调试日期走它 */
  setClock: (setting: ClockSetting) => void;
  /** 重新向服务端对表。回到前台时调用 */
  resyncClock: () => void;
  /**
   * 完成结账。
   *
   * 走 `plan.settle`（一条命令、一个版本、一个回滚点），
   * 完成后把 `lastSeen` 写到设备设置里。
   */
  settle: (choice: { done: string[]; skipped: string[]; carry: SettleCarry }) => Promise<void>;
  /** 这次先不结账。记下今天，免得每次打开都弹 */
  dismissSettle: () => void;
  /**
   * 演示/调试：假装过了 N 天再回来，并立刻判一次补账。
   *
   * 演示当天没法真的等一天，而它同时是这条链路的测试入口。
   */
  simulateDaysLater: (days: number) => Promise<void>;
  /** 让模型把补账事实说成人话；失败就用本机叙述 */
  narrateSettle: (facts: SettleFacts) => Promise<{ narrative: string; source: 'llm' | 'local'; note: string }>;

  /* ── 复盘 / 协商会话 ─────────────────────────────────── */

  /**
   * 开一次复盘。
   *
   * 整场会话的内容**全部本机算出来**（事实、问题、候选卡、方向），
   * 所以它在断网时完整可用。模型只负责把方向那句话和卡片上的理由说得更顺。
   */
  startReview: () => void;
  /** 回答复盘的一个问题。答案会改变候选卡，所以这里要重算 */
  answerReview: (questionId: string, answer: Answer) => void;
  /** 改一张建议卡（编辑页改完返回时调它） */
  editProposal: (key: string, next: Proposal) => void;
  /** 划掉 / 取消划掉一张卡 */
  toggleProposal: (key: string) => void;
  /** 把没划掉的那些一次写回（**一条命令**） */
  applySession: () => void;
  /** 放弃这次会话。什么都没写盘，所以不需要确认 */
  discardSession: () => void;

  /* ── 跟 AI 说说 ──────────────────────────────────────── */

  /**
   * 说一句话。
   *
   * 学生会话**先落到界面上**（乐观显示成气泡），再去问模型——
   * 打了一句话却看不到它出现，是最让人以为「没发出去」的交互。
   */
  sayToAi: (utterance: string) => Promise<void>;
  /** 回答一个澄清问题。回答也是一轮「学生的话」 */
  answerTalk: (questionId: string, label: string) => Promise<void>;

  /**
   * 撤销刚才那次应用。
   *
   * **只对紧接着的那一次动作有效**：任何一次新改动都会把快照清掉，
   * 通知条上那个〔撤销〕随之消失。这不是版本管理，是一次动作的反悔权。
   */
  undoLastApply: () => void;
};

const PlanContext = createContext<Store | null>(null);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 把一条作答压成一行字，存进复盘记录的 `dialogue`。
 *
 * 存的是**选项的文字**而不是它的键：`single` 的答案是 `'time'` 这种键，
 * 直接把键写进文件，半年后翻日志的人（包括我们自己）看不懂。
 */
function formatAnswer(a: Answer | undefined, q: QuestionSpec): string {
  if (!a) return '（没答）';
  const label = (v: string) => q.options.find((o) => o.value === v)?.label ?? v;
  switch (a.kind) {
    case 'single':
      return label(a.value);
    case 'multi':
      return a.values.map(label).join('、') || '（没选）';
    case 'scale':
      return `${a.value}${q.unit ?? ''}`;
    case 'date':
      return a.value ?? '（没填）';
    case 'dateRange':
      return `${a.from} ~ ${a.to}`;
    case 'text':
      return a.value || '（没填）';
  }
}

export function PlanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  /** 已落盘的修订号。放 ref 里：它只给 effect 做比较，不参与渲染 */
  const savedRev = useRef(0);
  /** 上一版计划文件的**原文**，saveWithSnapshot 要拿它存快照 */
  const prevFile = useRef<{ version: number; text: string } | null>(null);
  /** 读不出文件时不写盘。放 ref 里是为了不让它进 effect 依赖造成重复保存 */
  const blocked = useRef(false);
  /** 设备上的设置。写的时候要拿它当底，所以放 ref 而不是只依赖 state */
  const settingsRef = useRef<AppSettings>(DEFAULT_SETTINGS);

  /** 把设置写回设备。**失败只提示，不阻断**——设置是辅助信息，写不进去不该让主流程停下来 */
  const persistSettings = useCallback((next: AppSettings) => {
    settingsRef.current = next;
    dispatch({ kind: 'settings', settings: next });
    void appSettingsStorage.writeSettings(serializeSettings(next)).catch((e: unknown) => {
      dispatch({ kind: 'notify', notice: { tone: 'error', text: `设置没能写进设备：${errText(e)}` } });
    });
  }, []);

  /**
   * 接上时钟基准。
   *
   * 调试模式：用设置里的日期，不问服务端（这个模式的意义就是脱离真实时间）。
   * 正常模式：问服务端；问不到就退回设备时间，并由界面标明「本机时间」。
   */
  const connectClock = useCallback(
    async (setting: ClockSetting, settings: AppSettings): Promise<void> => {
      const base: ClockBase =
        setting.mode === 'debug' && setting.date
          ? baseFromSetting(setting, baseFromDevice())
          : ((await fetchServerTime().then((t) => (t ? baseFromTime(t) : null))) ?? baseFromDevice());
      const read = setBase(base);
      dispatch({ kind: 'clock', today: read.today, source: read.source, setting, settings });
    },
    [],
  );

  /* ── 启动：设置 → 时钟 → 设备上的计划文件；没有就写入初始计划 ──── */
  useEffect(() => {
    let alive = true;
    // 重试时要先把封锁解除，否则学生按提示改好文件之后仍然写不进去
    blocked.current = false;
    void (async () => {
      // 1) 设置。读不出来就用默认值——它是我们写的东西，不该把 App 卡住
      let settings = DEFAULT_SETTINGS;
      try {
        settings = parseSettings(await appSettingsStorage.readSettings());
      } catch {
        settings = DEFAULT_SETTINGS;
      }
      settingsRef.current = settings;
      if (!alive) return;

      // 2) 时钟。必须在读计划之前接上：补账判定要用「今天」
      try {
        await connectClock(settings.clock, settings);
      } catch {
        // connectClock 内部已经兜底过设备时间，这里只防意外
      }
      if (!alive) return;

      // 3) 计划
      let text: string | null;
      try {
        text = await planStorage.readPlan(PLAN_ID);
      } catch (e) {
        if (alive) {
          dispatch({ kind: 'loadFailed', failure: { kind: 'io', message: `读取设备失败：${errText(e)}` } });
          dispatch({ kind: 'storageReady' });
        }
        return;
      }
      if (!alive) return;

      try {
        if (text === null) {
          // 首次运行：把初始计划**真的**写到设备上。
          // 这样「翻到文件本体」在任何时刻都成立，而不是在内存里演一遍
          await planStorage.writePlan(PLAN_ID, DEMO_PLAN_TEXT);
          // 读回来当 `planText`，而不是拿刚写下去的那份充数——
          // 万一写盘没生效，这里立刻就能看出来
          const back = await planStorage.readPlan(PLAN_ID);
          if (back === null) throw new Error('写入后立刻读取却为空');
          if (!alive) return;
          // 版本号从**解析结果**里取，不写死。原来这里硬编码 5，
          // 一旦示例文件升到 v6，快照链就会拿错误的版本号去比对，
          // 而且不会报错——只是回滚时少一版
          const seeded = parsePlan(back);
          if (!seeded.ok) throw new Error(`内置示例计划无法解析：${seeded.error}`);
          prevFile.current = { version: seeded.plan.version, text: back };
          dispatch({ kind: 'seeded', planText: back });
          return;
        }

        const r = parsePlan(text);
        if (r.ok) {
          // 这里曾经有一句 `syncClockTo(r.plan.meta.updated)`——把时钟推到计划
          // 更新时间之后，好绕过「命令时间早于 meta.updated 就拒绝」那条规则。
          // 规则删了，从计划反推时钟这个绕法也就没有理由了。
          prevFile.current = { version: r.plan.version, text };
          dispatch({ kind: 'hydrate', plan: r.plan, planText: text });
        } else {
          // 多半是学生手改时敲错了。**不覆盖**——那会把他的编辑抹掉
          blocked.current = true;
          dispatch({
            kind: 'loadFailed',
            failure: { kind: 'parse', message: `设备上的计划文件无法解析：${r.error}` },
          });
        }
      } catch (e) {
        if (alive) dispatch({ kind: 'loadFailed', failure: { kind: 'io', message: `写入设备失败：${errText(e)}` } });
      } finally {
        if (alive) dispatch({ kind: 'storageReady' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [state.reloadToken]);

  /* ── 每次变更落盘（带上一版快照） ────────────────────────── */
  useEffect(() => {
    if (!state.storageReady || !state.plan) return;
    if (blocked.current) return;
    if (state.planRev === savedRev.current) return;

    const plan = state.plan;
    const rev = state.planRev;
    const text = serializePlan(plan);

    dispatch({ kind: 'saveStatus', save: { status: 'saving', message: null } });
    void (async () => {
      try {
        await saveWithSnapshot(planStorage, plan, prevFile.current ?? undefined);
        // 写完必须读回来。见文件头「写下去之后要读回来核对」
        const back = await planStorage.readPlan(PLAN_ID);
        if (back !== text) {
          dispatch({
            kind: 'saveStatus',
            save: {
              status: 'error',
              message:
                back === null
                  ? '刚写下去的内容读不回来，设备上可能什么都没存住'
                  : '写盘后读回来的内容和写下去的不一致，存储层可能有问题',
            },
          });
          return;
        }
        savedRev.current = rev;
        prevFile.current = { version: plan.version, text };
        dispatch({ kind: 'saved', planText: back });
      } catch (e) {
        dispatch({ kind: 'saveStatus', save: { status: 'error', message: `保存失败：${errText(e)}` } });
      }
    })();
    // 依赖里刻意没有 state.save.status：它会在写盘过程中变化，加进来会触发重复保存
  }, [state.plan, state.planRev, state.storageReady]);

  const apply = useCallback((cmd: PlanCommand, at: string = nextStamp()) => {
    // 时间戳在这里取，不在 reducer 里——见文件头注释
    dispatch({ kind: 'apply', cmd: { ...cmd, at } as Command });
  }, []);

  const dismissNotice = useCallback(() => dispatch({ kind: 'dismissNotice' }), []);
  const notify = useCallback((notice: Notice | null) => dispatch({ kind: 'notify', notice }), []);

  /**
   * 装入生成的计划。
   *
   * `expectRev` 是**发起生成那一刻**的修订号。生成要 20–40 秒，这期间
   * 学生可能已经改过计划——那样直接装进去会静默覆盖他的修改（见 reducer 里的注释）。
   * `profile` 会一并写进计划文件，所以「生成计划」只需要一次写盘。
   */
  const installPlan = useCallback(
    (text: string, note: string, expectRev?: number, profile?: LearnerProfile | null) =>
      dispatch({
        kind: 'installPlan',
        text,
        note,
        ...(expectRev === undefined ? {} : { expectRev }),
        ...(profile === undefined ? {} : { profile }),
      }),
    [],
  );

  const forceOverwrite = useCallback(() => {
    blocked.current = false;
    dispatch({ kind: 'unblock' });
  }, []);

  const retryLoad = useCallback(() => dispatch({ kind: 'retryLoad' }), []);

  /* ── 时钟 ────────────────────────────────────────────── */

  const setClock = useCallback(
    (setting: ClockSetting) => {
      const next: AppSettings = { ...settingsRef.current, clock: setting };
      settingsRef.current = next;
      // 立刻把设置写下去，再连时钟。反过来写的话，正常模式对表要等几秒网络，
      // 学生在这期间杀掉 App 就会丢掉他刚做的选择
      void appSettingsStorage.writeSettings(serializeSettings(next)).catch(() => undefined);
      void connectClock(setting, next);
    },
    [connectClock],
  );

  const resyncClock = useCallback(() => {
    void connectClock(settingsRef.current.clock, settingsRef.current);
  }, [connectClock]);

  /**
   * 回到前台时重新对表。
   *
   * 只对正常模式有意义：调试模式的「今天」是**故意**冻结的，
   * 重新对表会把它拽回真实日期——那正是这个模式要避免的事。
   *
   * 不跑定时器：一个每分钟醒一次、绝大多数时候什么都不做的定时器，
   * 在手机上是要用电池换的。回到前台这一次已经覆盖了绝大多数场景。
   */
  useEffect(() => {
    if (state.clockSetting.mode !== 'live') return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') resyncClock();
    });
    return () => sub.remove();
  }, [state.clockSetting.mode, resyncClock]);

  /* ── 补账 ────────────────────────────────────────────── */

  /** 记下「今天打开过」。写的是设备设置，不是计划——理由见 app-settings.ts */
  const markSeen = useCallback(
    (day: string) => {
      if (!day || settingsRef.current.lastSeen === day) return;
      persistSettings({ ...settingsRef.current, lastSeen: day });
    },
    [persistSettings],
  );

  /**
   * 启动时的补账判定。**每次会话只判一次**。
   *
   * 条件两个都要满足：真的隔了 ≥1 天，而且计划里确实有受影响的任务。
   * 只满足第一个（隔了 5 天但该做的都做完了）不该拿一个空页面拦人。
   */
  const runSettleCheck = useCallback(
    (plan: PlanFile | null, today: string, lastSeen: string | null) => {
      if (!plan || !today) return;
      if (!lastSeen) {
        // 没有「上次」就没有「这段时间」。硬拿 meta.created 当基准会在
        // 第一次打开时弹出一个莫名其妙的页面
        markSeen(today);
        return;
      }
      if (daysBetween(lastSeen, today) < 1) return;

      const facts = settleFacts(plan, lastSeen, today);
      if (!facts || !facts.pending.length) {
        markSeen(today);
        return;
      }
      dispatch({ kind: 'settleDue', facts });
    },
    [markSeen],
  );

  const settleChecked = useRef(false);
  useEffect(() => {
    if (settleChecked.current) return;
    if (!state.plan || !state.storageReady || !state.today) return;
    settleChecked.current = true;
    runSettleCheck(state.plan, state.today, state.settings.lastSeen);
  }, [state.plan, state.storageReady, state.today, state.settings.lastSeen, runSettleCheck]);

  const narrateSettle = useCallback(async (facts: SettleFacts) => {
    const localText = settlePlanText(facts);
    const input = settleNarrativeInput(facts, facts.goalStatement, localText);
    const res = await fetchSettleNarrative(input);
    if (!res.ok) return { narrative: localText, source: 'local' as const, note: res.error };
    return { narrative: res.value.narrative, source: res.value.source, note: res.value.note };
  }, []);

  const settle = useCallback(
    async (choice: { done: string[]; skipped: string[]; carry: SettleCarry }) => {
      const facts = state.pendingSettle;
      if (!facts || !state.plan) return;

      const at = nextStamp();
      const carry = choice.carry;
      apply(
        {
          type: 'plan.settle',
          from: facts.from,
          to: facts.to,
          pending: facts.pending.map((p) => p.taskId),
          done: choice.done,
          skipped: choice.skipped,
          carry,
          // 压缩的排期由引擎算好（facts.compress.plan），命令层只负责应用——
          // 命令层不许自己再算一遍，否则同一件事有两个实现
          ...(carry === 'compress' ? { reschedule: facts.compress.plan } : {}),
          review: {
            at,
            // 结账**不是**复盘。`plan.settle` 也往 reviews 里写一条，
            // 所以必须标出来——否则复盘页底部那个「之前的复盘」会把结账记录也列进去
            kind: 'settle',
            // 这段时间本该完成的总数 = 没做的 + 已经做完的
            plannedTasks: facts.pending.length + facts.doneCount,
            completedTasks: facts.doneCount + choice.done.length,
            // 结账不是负载自评，留空而不是编一个数
            loadFeedback: null,
            notes: `结账 ${facts.from} ~ ${facts.to}`,
            adjustments: [],
            // 结账没有问答
            dialogue: [],
          },
        },
        at,
      );
      markSeen(facts.to);
      dispatch({ kind: 'settleDone' });
    },
    [state.pendingSettle, state.plan, apply, markSeen],
  );

  const dismissSettle = useCallback(() => {
    // 记下今天，免得每次打开都弹。学生改主意了还能从文件页的「时间」区块进
    markSeen(state.today || state.pendingSettle?.to || '');
    dispatch({ kind: 'settleDone' });
  }, [markSeen, state.today, state.pendingSettle]);

  /**
   * 假装过了 N 天再回来。
   *
   * 演示当天没法真的等一天，而**这个按钮同时是这条功能链路的测试入口**——
   * 一个按钮同时服务演示和验证，比造两个入口好：它们不会各自跑偏。
   */
  const simulateDaysLater = useCallback(
    async (days: number) => {
      if (!state.plan) return;
      const from = state.today;
      const to = addDays(from, days);
      const setting: ClockSetting = { mode: 'debug', date: to };
      const next: AppSettings = { ...settingsRef.current, clock: setting, lastSeen: from };

      settingsRef.current = next;
      await appSettingsStorage.writeSettings(serializeSettings(next)).catch(() => undefined);
      await connectClock(setting, next);

      const facts = settleFacts(state.plan, from, to);
      if (facts && facts.pending.length) {
        dispatch({ kind: 'settleDue', facts });
      } else {
        // 不说一声的话，按钮看起来就是坏的
        dispatch({
          kind: 'notify',
          notice: { tone: 'error', text: `${from} ~ ${to} 之间没有需要结算的任务` },
        });
      }
    },
    [state.plan, state.today, connectClock],
  );

  /* ── 复盘 / 协商会话 ─────────────────────────────────── */

  /**
   * 开一次复盘：事实、问题、候选卡、方向**全部本机算**。
   *
   * 所以断网时这一屏是完整可用的；模型只负责把方向那句话和卡片上的理由
   * 说得更顺（有它更好，没它也一样能走完）。
   */
  const startReview = useCallback(() => {
    const plan = state.plan;
    if (!plan) return;
    const report = reviewPlan(plan, state.today);
    const questions = reviewQuestions(plan, report);
    const proposals = reviewProposals(plan, report);
    dispatch({
      kind: 'session',
      session: {
        source: 'review',
        direction: reviewDirection(plan, report, proposals),
        proposals,
        origin: proposals,
        dropped: [],
        questions,
        answers: {},
        refusals: [],
        history: [],
        unavailable: null,
      },
    });
  }, [state.plan, state.today]);

  /**
   * 回答一个问题，并**重算候选卡**。
   *
   * 重算时按 `proposalKey` 把学生改过的那几条留在原地：
   * 否则「先改了一张卡、再回答问题」会把他刚改的东西悄悄冲掉，
   * 而学生完全不知道发生了什么。答案确实会让某条卡消失时，
   * 那条改动也一并消失——这是对的，因为那条建议已经不成立了。
   */
  const answerReview = useCallback(
    (questionId: string, answer: Answer) => {
      const plan = state.plan;
      const cur = state.session;
      if (!plan || !cur) return;
      const answers = { ...cur.answers, [questionId]: answer };
      const report = reviewPlan(plan, state.today);
      const fresh = reviewProposals(plan, report, answers);
      const editedByKey = new Map(cur.proposals.map((p) => [proposalKey(p), p]));
      const originKeys = new Set(cur.origin.map((p) => proposalKey(p)));

      const proposals = fresh.map((p) => {
        const key = proposalKey(p);
        const kept = editedByKey.get(key);
        // 只在「学生改过这一条」时才用旧的：没改过就用新算出来的
        if (!kept || !originKeys.has(key)) return p;
        const was = cur.origin.find((o) => proposalKey(o) === key);
        return JSON.stringify(kept) === JSON.stringify(was) ? p : kept;
      });

      dispatch({
        kind: 'session',
        session: {
          ...cur,
          answers,
          proposals,
          origin: fresh,
          direction: reviewDirection(plan, report, fresh),
        },
      });
    },
    [state.plan, state.session, state.today],
  );

  const editProposal = useCallback(
    (key: string, next: Proposal) => {
      const cur = state.session;
      if (!cur) return;
      dispatch({
        kind: 'session',
        session: { ...cur, proposals: cur.proposals.map((p) => (proposalKey(p) === key ? next : p)) },
      });
    },
    [state.session],
  );

  const toggleProposal = useCallback(
    (key: string) => {
      const cur = state.session;
      if (!cur) return;
      const dropped = cur.dropped.includes(key)
        ? cur.dropped.filter((k) => k !== key)
        : [...cur.dropped, key];
      dispatch({ kind: 'session', session: { ...cur, dropped } });
    },
    [state.session],
  );

  /**
   * 把没划掉的那些一次写回。
   *
   * **一条命令**——任务、目标、档案全在 `plan.applyAdjustments` 里，
   * 所以一次应用 = 一次版本 +1 + 一条历史 + 一次写盘。
   * 拆开的话，中间任何一条被拒都会留下「计划改了一半、档案没改」，
   * 而现在没有回滚能整体撤掉。
   */
  const applySession = useCallback(() => {
    const cur = state.session;
    const plan = state.plan;
    if (!cur || !plan) return;

    const chosen = cur.proposals.filter((p) => !cur.dropped.includes(proposalKey(p)));
    if (!chosen.length) return;

    // 新增对象的 id 由代码生成（模型/规则都不碰 id）。
    // **必须用共享层的 `allocateIds`**：`placeNewTasks()` 在更早的时候
    // 用同一个纯函数算过一遍 id，才把引擎排好的日期写回卡片；
    // 这里再自己算一遍的话，两边的 id 一旦不同，「排好日期的那个任务」
    // 和「最后写进计划的任务」就是两个东西。
    const ids = allocateIds(plan, chosen);
    const applied = chosen.map((p) => toAppliedAdjustment(p, ids.get(proposalKey(p))));

    // 记下**应用之前**的那份，供撤销用。必须在 apply 之前取
    const before = plan;
    apply({
      type: 'plan.applyAdjustments',
      applied,
      review: {
        at: nextStamp(),
        kind: 'review',
        plannedTasks: 0,
        completedTasks: 0,
        loadFeedback: null,
        notes: cur.source === 'review' ? cur.direction : '跟 AI 说说',
        adjustments: chosen.map((p) => p.reason),
        dialogue: cur.questions.map((q) => ({
          prompt: q.prompt,
          answer: formatAnswer(cur.answers[q.id], q),
        })),
      },
    });
    dispatch({ kind: 'session', session: null });
    // 顺序要紧：`apply` 会把上一次的快照清掉（保证撤销活不过下一次改动），
    // 所以这一次的快照要在它之后补上
    dispatch({ kind: 'undoable', snapshot: before });
  }, [state.session, state.plan, apply]);

  const discardSession = useCallback(() => dispatch({ kind: 'session', session: null }), []);

  /**
   * 撤销刚才那次应用。
   *
   * 走 `plan.restore`（现成的、有测试的纯函数）：整份恢复到应用之前。
   * 不做反向命令——删任务的反向要恢复任务数据和别人的前置引用，
   * 漏一处就留下一个不一致的计划。
   *
   * 恢复本身也是一次正常的写入，所以它同样 +1 版、同样留一条历史。
   */
  const undoLastApply = useCallback(() => {
    const snapshot = state.undoSnapshot;
    if (!snapshot || !state.plan) return;
    apply({ type: 'plan.restore', snapshot });
    dispatch({ kind: 'notify', notice: { tone: 'success', text: '已撤销刚才那次改动' } });
  }, [state.undoSnapshot, state.plan, apply]);

  /* ── 跟 AI 说说 ──────────────────────────────────────── */

  /**
   * 一次往返。
   *
   * 两处细节：
   *  · **学生的这句话先上屏**，再去问模型。打了一句话却看不到它出现，
   *    是最让人以为「没发出去」的交互。
   *  · 失败时**不丢掉会话**：那句话还在，界面显示「现在用不了」+ 手动入口。
   *    直接清空的话，学生刚打的那句话就白打了。
   */
  const roundTrip = useCallback(
    async (history: TalkTurn[]) => {
      const plan = state.plan;
      if (!plan) return;
      const cur = state.session;
      const base: ProposalSession = cur ?? {
        source: 'talk',
        direction: '',
        proposals: [],
        origin: [],
        dropped: [],
        questions: [],
        answers: {},
        refusals: [],
        history: [],
        unavailable: null,
      };
      // 先把学生这句话显示出来
      dispatch({ kind: 'session', session: { ...base, source: 'talk', history, unavailable: null } });

      const res = await fetchTalk({
        plan: serializePlan(plan),
        today: state.today,
        profile: state.profile,
        history,
      });

      if (!res.ok) {
        dispatch({ kind: 'session', session: { ...base, source: 'talk', history, unavailable: res.error } });
        return;
      }

      const r = res.result;
      dispatch({
        kind: 'session',
        session: {
          ...base,
          source: 'talk',
          // 「我听懂了什么」和复盘里的「方向」是同一个位置的东西，共用 `direction`
          direction: r.understanding,
          proposals: r.proposals,
          origin: r.proposals,
          dropped: [],
          questions: r.questions,
          refusals: r.refusals,
          unavailable: null,
          // 把 AI 这一轮也记进上下文：下一轮要能看到它问过什么
          history: [...history, { role: 'ai', understanding: r.understanding, questions: r.questions }],
        },
      });
    },
    [state.plan, state.today, state.profile, state.session],
  );

  const sayToAi = useCallback(
    async (utterance: string) => {
      const text = utterance.trim();
      if (!text) return;
      const cur = state.session?.source === 'talk' ? state.session.history : [];
      await roundTrip([...cur, { role: 'student', text }]);
    },
    [state.session, roundTrip],
  );

  const answerTalk = useCallback(
    async (questionId: string, label: string) => {
      const cur = state.session;
      if (!cur) return;
      const q = cur.questions.find((x) => x.id === questionId);
      if (!q) return;
      await roundTrip([...cur.history, answerTurn(q.prompt, label)]);
    },
    [state.session, roundTrip],
  );

  const value = useMemo<Store>(
    () => ({
      ...state,
      realToday: readingOf(baseFromDevice()).today,
      apply,
      dismissNotice,
      notify,
      installPlan,
      forceOverwrite,
      retryLoad,
      setClock,
      resyncClock,
      settle,
      dismissSettle,
      simulateDaysLater,
      narrateSettle,
      startReview,
      answerReview,
      editProposal,
      toggleProposal,
      applySession,
      discardSession,
      sayToAi,
      answerTalk,
      undoLastApply,
    }),
    [
      state,
      apply,
      dismissNotice,
      notify,
      installPlan,
      forceOverwrite,
      retryLoad,
      setClock,
      resyncClock,
      settle,
      dismissSettle,
      simulateDaysLater,
      narrateSettle,
      startReview,
      answerReview,
      editProposal,
      toggleProposal,
      applySession,
      discardSession,
      sayToAi,
      answerTalk,
      undoLastApply,
    ],
  );

  return <PlanContext.Provider value={value}>{children}</PlanContext.Provider>;
}

export function usePlanStore(): Store {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error('usePlanStore 必须在 <PlanProvider> 内使用');
  return ctx;
}

/**
 * 存储后端信息，给文件页显示用。
 *
 * 不需要动态 import：Metro 的平台解析在**打包时**就完成了，
 * web 包里根本不会出现 `plan-storage.ts`（那份 import 了 expo-file-system），
 * 原生包里也不会出现 `.web.ts` 那份。
 */
export function useStorageInfo() {
  return useMemo(
    () => ({ backend: storageBackend, root: storageRoot, hint: storageHint }),
    [],
  );
}
