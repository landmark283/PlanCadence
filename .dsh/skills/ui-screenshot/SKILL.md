---
name: ui-screenshot
description: Capture deterministic full-page screenshots of the Expo Web build of this project (and surface console/page errors), so UI changes can be reviewed visually without a human describing the screen. Use after any change to apps/mobile UI, when asked to "see the UI", "check how it looks", "verify the screens render", or before claiming a visual change is done. Requires a prior `expo export --platform web` (or pass --url for a running dev server).
whenToUse: Load when a UI change in apps/mobile needs visual verification, or when a page error/blank screen is suspected. Do NOT use for logic-only changes in packages/shared — those are covered by `node --test`.
---

# ui-screenshot：对 Expo Web 产物做确定性截屏

## 为什么存在这条技能

这个项目里「漂亮的前端」是参赛硬要求，而**视觉问题是唯一无法靠单测发现的**。
人类看一次屏幕要花 5–20 分钟沟通，而截屏 + 我自己看图是秒级的。
这条技能把 UI 观察循环从「等人类描述」压缩成「自己跑一次」。

刻意**不用** runsight 那类「AI 视觉自主探索」工具：它需要视觉模型 Key，
且每次走的路径不同，无法做前后对比。UI 迭代要的是**同样路由、同样视口、每次一样**。

## 前置条件

1. playwright 已安装且 chromium 已下载：
   ```
   pnpm add -D -w playwright
   $env:PLAYWRIGHT_BROWSERS_PATH='<workspace>\.playwright'; pnpm exec playwright install chromium
   ```
   （脚本已默认把 `PLAYWRIGHT_BROWSERS_PATH` 指向 `<workspace>/.playwright`，无需每次设置）
2. 有构建产物，或有一个在跑的 dev server。

## 用法

### 方式 A：静态产物（推荐，确定性最好）

```bash
# 1) 生成产物（约 15–20 秒）
pnpm --filter @sp/mobile exec expo export --platform web

# 2) 截屏
node <SKILL_BASE>/scripts/shoot.mjs \
  --dist apps/mobile/dist \
  --out  outputs/screenshots \
  --routes /,/explore
```

### 方式 B：直接打 dev server

```bash
pnpm --filter @sp/mobile exec expo start --web --port 8081   # 另开一个后台任务
node <SKILL_BASE>/scripts/shoot.mjs --url http://127.0.0.1:8081 --routes /
```

方式 B 迭代更快（HMR），但首屏依赖 dev server，截图可能带上 HMR 覆盖层，**正式对比请用方式 A**。

## 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--dist` | `apps/mobile/dist` | 静态产物目录 |
| `--out` | `outputs/screenshots` | 截图输出目录 |
| `--routes` | `/` | 逗号分隔；`/` 存成 `index.png` |
| `--viewport` | `375x812` | 与演示机型一致，别用桌面宽度自欺欺人 |
| `--url` | — | 指定后不启内置静态服务器 |

`<SKILL_BASE>` = 本技能目录（DSH 会在加载技能时给出 Base directory）。

## 读图与判读

脚本会输出每个路由的截图路径与 `body` 高度，并在最后列出页面 console / page 错误。
**退出码 2 表示截图生成了但页面有报错**——这种情况不要宣称 UI 已完成。

拿到路径后用 `read_image` 工具直接看图，重点检查：

1. **空状态**：无数据时是否是一屏空白（评委一定会点到）
2. **溢出与截断**：中文长标题、长任务名在 375pt 下是否换行正常
3. **安全区**：刘海/圆角/底部 Home indicator 是否遮挡内容
4. **一致性**：圆角、间距（4 的倍数）、主色是否统一
5. **深浅色**：切换系统主题后再截一次对比

## 已知坑

- `expo export` 会输出到 `apps/mobile/dist`，已在 `.gitignore` 里。
- 静态导出用 `output: 'static'`，路由是 `/explore` → `explore.html`；内置服务器已处理这个映射。
- 若报 `browserType.launch: Executable doesn't exist`，说明 chromium 没装到 `.playwright`，重跑上面的 `playwright install chromium`。
- 截图是 `fullPage: true`；想看首屏可视区域的效果，把视口高度说清楚即可，不要改这个默认值——fullPage 更容易发现底部溢出。
