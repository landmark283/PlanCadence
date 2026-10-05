/**
 * 应用设置 —— 存在设备上的那一小份「这台机器怎么用」。
 *
 * ## 为什么不放进计划文件
 *
 * 里面这两个字段都是**这台设备的使用状态**，不是计划的属性：
 *
 * - `clock`（调试开关）如果写进计划文件，这份文件被复制到别人机器上时
 *   会**带着调试模式一起过去**，对方打开看到的是一个冻结的日期。
 * - `lastSeen`（上次打开）如果写进计划，那么「我今天打开过一次」这件事
 *   会**让版本号 +1**。版本历史是给人看的，「我看了一眼提示」不该在里面占一行——
 *   和 `plan.attachResources` 当初被做成一条命令而不是十几条是同一个道理。
 *
 * 结果是计划文件一个字段都不用加，schema 不用动版本。
 *
 * ## 解析不了就用默认值，不报错
 *
 * 这份文件是程序自己写的，学生基本碰不到。真读不出来时最合理的反应是
 * **当作没设置过**继续跑，而不是把整个 App 卡在一句「设置文件损坏」上。
 * 这一点和计划文件相反——计划文件读不出来会明确报错并**拒绝覆盖**，
 * 因为那是学生的东西；这份是我们的。
 */
import { z } from 'zod';

import { ClockSetting, DEFAULT_CLOCK_SETTING } from './clock.ts';

export const SETTINGS_FILE_NAME = 'settings.json' as const;

export const AppSettings = z.object({
  clock: ClockSetting.default(DEFAULT_CLOCK_SETTING),
  /** 上次打开是哪天。补账区间的起点 */
  lastSeen: z.string().nullable().default(null),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = { clock: DEFAULT_CLOCK_SETTING, lastSeen: null };

/** 读不出来、读坏了、字段不全 —— 一律退回默认值 */
export function parseSettings(text: string | null | undefined): AppSettings {
  if (!text) return DEFAULT_SETTINGS;
  try {
    const r = AppSettings.safeParse(JSON.parse(text));
    return r.success ? r.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function serializeSettings(s: AppSettings): string {
  return `${JSON.stringify(AppSettings.parse(s), null, 2)}\n`;
}

export type SettingsStorage = {
  readSettings(): Promise<string | null>;
  writeSettings(text: string): Promise<void>;
};
