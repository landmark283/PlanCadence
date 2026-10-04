/**
 * 计划状态 —— 前端唯一允许改动计划的地方。
 *
 * 铁律（来自 commands.ts）：任何状态变更都必须走 `applyCommand`，
 * 组件里不许直接改 plan 对象。所以这里把 `applyCommand` 包成一个 store，
 * 界面拿到的永远是新的、已校验过的 plan。
 *
 * ## 落盘
 *
 * 每次成功变更都会写回设备上的 `.studyplan` 文件，并留下上一版的整份快照
 * （回滚靠快照，不靠重放命令）。判断「有没有未落盘的改动」用的是
 * **单调递增的修订号**而不是版本号：重新生成计划时版本号会回到 v1，
 * 用版本号判断会导致「v1 → v1」这种改动被当成没事发生。
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
 * 把两者报成同一句话，真机上排查时会被引去查格式，而问题在存储层。
 * 所以 `loadError` 带 `kind`。
 *
 * ## 写下去之后要读回来核对
 *
 * `planText` 的定义是「**设备上那份文件的原文**」。如果写入后直接把它设成
 * 刚序列化出来的字符串，这个定义就是假的——写盘静默失效时界面照样显示
 * 「已保存到设备」，而设备上什么都没有。所以每次写完都重新读一遍，
 * 读回来的东西和写下去的**不一致就报错**，宁可显示失败也不要显示一个假的成功。
 *
 * ## 为什么 `at` 在 dispatch 之前取
 *
 * reducer 必须是纯函数（StrictMode 下会被调两次），时钟读数放进 reducer
 * 会让两次调用产生不同的时间戳。
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
import {
  applyCommand,
  parsePlan,
  saveWithSnapshot,
  serializePlan,
  type Command,
  type LearnerProfile,
  type PlanFile,
} from '@sp/shared';

import { DEMO_PLAN_TEXT } from '@/fixtures/demo-plan';
import { DEMO_TODAY, nowStamp, syncClockTo } from '@/state/clock';
import { planStorage, storageBackend, storageHint, storageRoot } from '@/storage/plan-storage';

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
   * 同一件事算两遍、其中一份没人用，是纯粹的分歧风险：
   * 哪天两边口径不一样（比如一边过滤了某些规则），谁也不会发现。
   */
  /** 访谈产出的学生档案。它是 `planner.draft` 的输入，生成计划前先存下来 */
  profile: LearnerProfile | null;
  /** 计划内容的修订号。每次成功变更 +1 */
  planRev: number;
  /** **设备上那份文件的文本**（不是内存里的），文件页要原样显示它 */
  planText: string;
  save: { status: SaveStatus; message: string | null };
  storageReady: boolean;
  /** 点「重试」时 +1，用来重新触发读取 effect */
  reloadToken: number;
};

type Action =
  | { kind: 'apply'; cmd: Command }
  | { kind: 'dismissNotice' }
  /** 直接放一条通知。给「正在检索…」这类不属于任何命令的反馈用 */
  | { kind: 'notify'; notice: Notice | null }
  | { kind: 'saveProfile'; profile: LearnerProfile }
  | { kind: 'installPlan'; text: string; note: string }
  | { kind: 'hydrate'; plan: PlanFile; planText: string }
  | { kind: 'seeded'; planText: string }
  | { kind: 'loadFailed'; failure: LoadFailure }
  | { kind: 'retryLoad' }
  | { kind: 'storageReady' }
  | { kind: 'saveStatus'; save: State['save'] }
  | { kind: 'saved'; planText: string }
  /** 解除「不许覆盖」的封锁，让当前计划写盘 */
  | { kind: 'unblock' };

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
        planRev: state.planRev + 1,
        notice: { tone: 'success', text: summary },
      };
    }

    case 'dismissNotice':
      return { ...state, notice: null };

    case 'notify':
      return { ...state, notice: action.notice };

    case 'saveProfile':
      return { ...state, profile: action.profile };

    case 'installPlan': {
      // 装进来的可能是服务端生成的、也可能是本机生成的文本。
      // 无论哪种都**必须在这里重新解析一遍**再进状态——
      // 一份解析不了的文本如果进了 store，会在每一屏各炸一次。
      const r = parsePlan(action.text);
      if (!r.ok) return { ...state, notice: { tone: 'error', text: `生成的计划无法解析：${r.error}` } };
      return {
        ...state,
        plan: r.plan,
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
  }
}

type Store = State & {
  /** 应用一条命令 */
  apply: (cmd: PlanCommand) => void;
  dismissNotice: () => void;
  /**
   * 放一条不属于任何命令的通知。
   *
   * 「正在检索资料…」这种进度反馈需要一个出口：它既不是命令的摘要，
   * 也不该为了显示它去造一条假命令。传 null 就是清掉。
   */
  notify: (notice: Notice | null) => void;
  /** 保存访谈档案。生成计划前调用 */
  saveProfile: (profile: LearnerProfile) => void;
  /** 装入一份新生成的计划文本（替换当前计划） */
  installPlan: (text: string, note: string) => void;
  /** 设备上的文件读不出来时，用当前内存里的计划覆盖它 */
  forceOverwrite: () => void;
  /** 存储出错后重新读一次（改了权限、换了后端、修好了文件都能靠它恢复） */
  retryLoad: () => void;
  /** 演示口径的今天。所有界面统一从 store 取，避免各页各写一个常量 */
  today: string;
  /**
   * 列出设备上留着的版本快照，从新到旧。
   *
   * 快照里存的是**整份文件原文**，所以每一条都能还原出当时的完整状态
   * （时间、任务数、目标原话）。这也是回滚不需要重放命令的原因——
   * 重放要求命令永久向后兼容，代价高且容易错。
   */
  listVersions: () => Promise<PlanVersion[]>;
  /** 回滚到某一版。返回 false 表示没成功（原因已作为通知显示出来） */
  restoreTo: (version: number) => Promise<boolean>;
};

/** 一条版本快照的摘要。给版本历史页显示用 */
export type PlanVersion = {
  version: number;
  /** 快照文件里记的更新时间 */
  updated: string | null;
  taskCount: number;
  doneCount: number;
  goalStatement: string | null;
  /** 原始文件文本，展开预览用 */
  text: string;
  /** 读不出来时这里放原因，其余字段为 null */
  broken: string | null;
};

const PlanContext = createContext<Store | null>(null);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PlanProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, init);

  /** 已落盘的修订号。放 ref 里：它只给 effect 做比较，不参与渲染 */
  const savedRev = useRef(0);
  /** 上一版计划文件的**原文**，saveWithSnapshot 要拿它存快照 */
  const prevFile = useRef<{ version: number; text: string } | null>(null);
  /** 读不出文件时不写盘。放 ref 里是为了不让它进 effect 依赖造成重复保存 */
  const blocked = useRef(false);

  /* ── 启动：读设备上的文件；没有就写入初始计划 ────────────── */
  useEffect(() => {
    let alive = true;
    // 重试时要先把封锁解除，否则学生按提示改好文件之后仍然写不进去
    blocked.current = false;
    void (async () => {
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
          // 关键：把演示时钟推到计划更新时间之后。
          // 不做这一步，重启后每一条命令都会被 `at < meta.updated` 拒掉。
          syncClockTo(r.plan.meta.updated);
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

  const apply = useCallback((cmd: PlanCommand) => {
    // 时间戳在这里取，不在 reducer 里——见文件头注释
    dispatch({ kind: 'apply', cmd: { ...cmd, at: nowStamp() } as Command });
  }, []);

  const dismissNotice = useCallback(() => dispatch({ kind: 'dismissNotice' }), []);
  const notify = useCallback((notice: Notice | null) => dispatch({ kind: 'notify', notice }), []);
  const saveProfile = useCallback((profile: LearnerProfile) => dispatch({ kind: 'saveProfile', profile }), []);
  const installPlan = useCallback((text: string, note: string) => dispatch({ kind: 'installPlan', text, note }), []);

  const forceOverwrite = useCallback(() => {
    blocked.current = false;
    dispatch({ kind: 'unblock' });
  }, []);

  const retryLoad = useCallback(() => dispatch({ kind: 'retryLoad' }), []);

  /**
   * 版本历史。
   *
   * 每条快照都读出来解析一遍——版本数是个位数，开销可以忽略，
   * 而读出来才能显示「那时候计划长什么样」。解析不了的快照**照常列出来**
   * 并标明坏了：静默跳过会让人以为那一版不存在，而它其实占着磁盘。
   */
  const listVersions = useCallback(async (): Promise<PlanVersion[]> => {
    const versions = await planStorage.listSnapshots(PLAN_ID);
    const rows = await Promise.all(
      versions.map(async (version): Promise<PlanVersion> => {
        const text = await planStorage.readSnapshot(PLAN_ID, version);
        if (text === null) {
          return { version, updated: null, taskCount: 0, doneCount: 0, goalStatement: null, text: '', broken: '快照读不出来' };
        }
        const r = parsePlan(text);
        if (!r.ok) {
          return { version, updated: null, taskCount: 0, doneCount: 0, goalStatement: null, text, broken: String(r.error) };
        }
        return {
          version,
          updated: r.plan.meta.updated,
          taskCount: r.plan.tasks.length,
          doneCount: r.plan.tasks.filter((t) => t.status === 'done').length,
          goalStatement: r.plan.goal.statement,
          text,
          broken: null,
        };
      }),
    );
    // 从新到旧：要回滚的几乎总是最近的那几版
    return rows.sort((a, b) => b.version - a.version);
  }, []);

  const restoreTo = useCallback(async (version: number): Promise<boolean> => {
    try {
      const text = await planStorage.readSnapshot(PLAN_ID, version);
      if (text === null) {
        dispatch({ kind: 'notify', notice: { tone: 'error', text: `v${version} 的快照读不出来，无法回滚` } });
        return false;
      }
      const r = parsePlan(text);
      if (!r.ok) {
        dispatch({ kind: 'notify', notice: { tone: 'error', text: `v${version} 的快照内容不合法，无法回滚：${r.error}` } });
        return false;
      }
      // 走命令层，不是直接改 state：回滚同样要留下历史、递增版本、过一次校验。
      // 命令层会拒绝「回滚到不比当前更早的版本」，所以这里不用自己判
      dispatch({ kind: 'apply', cmd: { type: 'plan.restore', at: nowStamp(), snapshot: r.plan } as Command });
      return true;
    } catch (e) {
      dispatch({ kind: 'notify', notice: { tone: 'error', text: `回滚失败：${errText(e)}` } });
      return false;
    }
  }, []);

  const value = useMemo<Store>(
    () => ({
      ...state,
      apply,
      dismissNotice,
      notify,
      saveProfile,
      installPlan,
      forceOverwrite,
      retryLoad,
      listVersions,
      restoreTo,
      today: DEMO_TODAY,
    }),
    [state, apply, dismissNotice, notify, saveProfile, installPlan, forceOverwrite, retryLoad, listVersions, restoreTo],
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
