# A 模块：真实 Codex 额度读取与交接

## 交付范围

本模块面向每位安装 PetCast 的用户：在用户自己的 Windows 电脑查找 Codex，读取该电脑当前已登录的 ChatGPT 账号。没有开发者的固定账号、设备路径、测试额度或登录凭据。不同电脑各自使用自己的登录和数据。

已完成数据读取、桌面 IPC 与主页面接入。默认尝试真实读取，用户可在“额度设置”或展开后的侧栏明确选择模拟演示。首次失败显示未知额度；同身份暂时失败显示旧快照和采样时间；旧数据暂停额度相关提醒与钓鱼。组员已反馈安装后额度正常；最终 EXE 和另一台电脑的完整异常验收仍需继续。

## 用户前提与开发验证

1. 用户电脑已安装 Codex，并使用自己的 ChatGPT 账号登录。PetCast 不提供新的登录页，也不读取用户的浏览器 Cookie。
2. 当前账号需返回完整的 300 分钟和 10080 分钟两个额度窗口。API Key 登录、未登录、缺失窗口都会明确报错。
3. 开发时在仓库根目录运行：

```powershell
pnpm install
pnpm typecheck
pnpm test:contracts
pnpm build
pnpm check:codex
```

`check:codex` 编译 Electron 模块，然后调用与产品相同的读取实现。成功时输出 `source: real`、剩余百分比及 UTC 时间；失败时输出经过脱敏的错误码和操作提示。它不会发起模型任务。

桌面通路验证（隐藏窗口、独立临时存档）：

```powershell
pnpm test:desktop
# 在已登录 Codex 的电脑再验证一次真实 IPC：
node scripts/smoke-desktop.mjs --codex
```

后一个命令要求先完成构建。验证成功分别显示 `Desktop smoke passed` 与 `Desktop smoke passed (real Codex IPC)`，不会打开可见窗口或覆盖现有游戏存档。

自动查找顺序：`PETCAST_CODEX_PATH` → PATH 中的原生 `codex.exe` → 当前用户 `%LOCALAPPDATA%\OpenAI\Codex\bin` 下的桌面版 Codex。遇到多个桌面版文件时，优先最近更新的可执行文件。

如果自动查找失败，可在启动 PetCast 的终端指定原生可执行文件：

```powershell
$env:PETCAST_CODEX_PATH = 'C:\实际安装位置\codex.exe'
pnpm check:codex
```

路径须由用户按实际安装位置填写；不接受命令行片段。通过 npm 安装后只有 `codex.cmd` 的环境，需要找到该安装的原生 `codex.exe`，或安装桌面版 Codex。生产安装包同样需要用户本机存在可用的 Codex；本轮未把 Codex 二进制捆绑进安装包。

## 接口与职责

| 文件 | 职责 |
| --- | --- |
| `electron/codexUsage.ts` | 查找并启动 App Server、读账号/额度、校验窗口、脱敏与进程清理 |
| `electron/codexProtocol.ts` | IPC DTO、允许的错误码与提示 |
| `electron/codexIpc.ts` | 校验调用页面、限制一个活动请求、取消、安装级随机盐 |
| `electron/main.ts` / `preload.ts` | 注册读取通道；注册通道与完整页面冒烟验证 |
| `src/usage/CodexUsageProvider.ts` | ISO 时间还原、连续采样速率、账号切换、重置检测 |
| `src/usage/providerFactory.ts` | 用户明确选择来源，创建独立 Provider / Reader |
| `src/usage/UsageReader.ts` | 合并并发请求、校验、超时、缓存与安全错误提示 |
| `src/usage/usageSnapshot.ts` | 复制快照及 Date，避免调用方修改内部缓存与速率历史 |
| `src/usage/usagePolling.ts` | 请求结束后再等待 30 秒；重置临近时提前重新查询 |
| `src/usage/UsageConnection.ts` / `useUsageConnection.ts` | 页面会话、来源偏好、取消、切换后清空旧视图、快照超龄及恢复刷新 |
| `src/components/UsageSettings.tsx` / `App.tsx` | 来源选择、状态反馈、手动刷新、游戏与模拟存档隔离 |
| `scripts/test-usage-ui.mjs` | 无网络页面验收，使用独立临时存档与测试额度 |
| `scripts/check-codex-usage.mjs` | 真实读取诊断工具 |
| `scripts/build-preload.mjs` | 把 typed preload 编译成沙箱兼容的 `preload.cjs`，保留隔离设置 |

主进程使用标准输入输出 JSON-RPC，只调用 `initialize`、`initialized`、`account/read`、`account/rateLimits/read`。没有创建推理任务、刷新额度、修改套餐或自动登录的操作。

原始响应、邮箱、原始账号 ID 和错误正文不进入渲染进程，也不写入日志。匿名标识使用本机随机盐计算，随机盐保存在应用用户目录的 `codex-scope-salt`。服务端返回 `accountId` 时，Provider 输出的 `UsageState.scopeId` 同时区分登录身份和账号 / 工作区，换工作区会断开速率历史；旧版本不提供该字段时仅按登录身份隔离。删除随机盐会改变本机历史数据作用域，不同设备上的标识不应直接合并。这里只提供数据隔离，报表由 D 实现。

IPC DTO 的 `scopeId` 标识登录身份，新增可选 `accountScopeId` 区分工作区；业务和历史模块应使用 Provider 输出的 `UsageState.scopeId`，不要直接记录原始 IPC DTO。网络失败而无法确认工作区时，最多保留上次已验证工作区的旧快照并标记 stale，不当作当前工作区的新数据。

## 给 C：已完成的接入与维护方式

当前 `App.tsx` 使用 `useUsageConnection`，由 `UsageConnection` 管理 Reader 和轮询。切换时立即清空旧视图并取消原读取。来源偏好保存在 `petcast.usage-source.v1`，默认 real；浏览器也明确提示不可读取，只有用户选择后才启用 mock。

游戏存档中的旧 `usage` 只保存和恢复模拟状态；水族箱、图鉴、邮箱仍共享保留。重置历史记录标记真实 / 模拟来源，旧的无标记记录显示“来源未标记”。D 的独立历史采样库现已接入，见 `docs/D_USAGE_HISTORY.md`。

下列为底层独立会话示例；不要在已有 hook 外再增加轮询：

```ts
import { createUsageSession } from './usage/providerFactory'
import { startUsagePolling } from './usage/usagePolling'

// source 来自用户明确选择；桌面端可默认 real，浏览器显示不可用或由用户选 mock。
const session = createUsageSession(source, window.petcast)
const polling = startUsagePolling(session.reader, reading => {
  // 将 reading 整体放入组件状态，不要只存余额。
  // status === 'unavailable' 时 data 为 null。
  // stale 显示上次采样时间和错误提示，不能当作最新数据。
  setReading(reading)
})

// 手动刷新：await polling.refresh()
// 离开页面或换来源前：polling.stop()
```

这段是独立使用示例，`source` / `setReading` 由使用方提供。React effect 清理应调用 `polling.stop()`，切换来源时先清空旧视图，再新建会话。无需自行叠加另一个定时器。

后续维护时需保持的约束：

- 真实模式在首次成功前显示“正在读取”或具体错误；不使用 `createMockUsageState()` 填充真实看板。
- `fresh` 可用于当前分析并交给 D 记录；`stale` 只显示旧快照及采样时间；`unavailable` 显示空状态，不能显示 0%。
- 旧快照不得触发重置庆祝、自动钓鱼或新的使用告警。真实数据不足时，暂停依赖额度的游戏行为，保留手动操作入口。
- 同一已验证账号的暂时性错误保留旧真实快照。退出登录、账号改变、格式错误或无法验证账号时清除缓存，避免显示另一账号数据。
- 隐藏真实模式的 Mock 滑块；只有用户选 Mock 后才能调用 `update` / `setScenario`。
- 现有游戏存档的 `usage` 没有来源标记，只能视为旧的模拟演示状态。不得恢复到真实 Provider；切换真实模式时必须重新读取。
- `null` 速度显示“数据不足”；不要使用 `?? 0` 计算统计或显示成零消耗。
- 倒计时归零只重新查询，不能自动将余额补到 100%。Provider 返回 `recentResetType` 才能触发确认重置。
- `main.ts` / `preload.ts` 的额度通道已接好。若 C 重构窗口文件，请保留 `registerCodexUsageIpc` 和两个白名单方法，不暴露任意 IPC / shell / 文件读取。

请求时限：主进程 `readCodexQuota` 的查找与接口会话共用 15 秒，工厂 Reader 20 秒。轮询不重叠；手动刷新复用正在进行的请求。停止轮询会取消当前真实读取，并忽略之后的回调；迟到的程序查找不会启动新进程。

主页面 `UsageConnection` 以原始 `sampledAt` 为准，超过 90 秒或检测到系统时钟回退时降为 stale，清除旧重置信号。重新获焦、恢复可见或联网时触发刷新；新响应仍需通过校验才能恢复 fresh。该保护是主页面会话的一部分，独立使用上述底层 Reader / Polling 示例时应另行处理展示新鲜度。服务端没有独立测量时间，90 秒不代表接口账单更新承诺。

取消后可以立即重试；旧请求的迟到结果不会改写新会话。重复调用同一个轮询器的 `stop()` 不会影响后来启动的轮询器。返回的快照与内部缓存 / 速率历史分离，调用方修改 Date 不会污染下一次计算。若 `onReading` 回调抛出错误，手动 `refresh()` 的调用者应处理拒绝；后台轮询会处理该拒绝并继续后续刷新。回调内自行启动的异步操作仍应自行处理错误。

## 给 D：数据含义

- 余额是服务端 `usedPercent` 转换后的剩余百分比，不是 Token 数、金额、API 套餐余额，也不是全平台 AI 总额度。
- `sampledAt` 是收到并校验本次服务端响应的时间。接口没有提供独立的测量时间，不能解释成服务端账单更新时间。旧缓存保留原采样时间。
- 只记录 `fresh`，按 `source + scopeId` 隔离，采样时间去重。
- 当前速率 = 同账号、同短窗口的剩余百分点下降量 / 实际间隔小时数；只接受不超过 5 分钟的连续片段。
- 速度属于采样估算，会受服务端百分比取整和刷新延迟影响，不能当作精确实时账单。
- 基准速率是本次运行、同一连续窗口内先前有效片段的时间加权均值，不是长期个人习惯结论。第一个有效片段有当前速率，但基准仍为 `null`。
- 首次采样、窗口变化、额度回升、长断档或账号变化都会断开速度计算。D 不得把 `null` 当 0。
- 重置检测要求重置边界向后推进、旧边界已到期且余额增加；同一事件只发一次。这是基于两次观测的保守判定，重置后余额仍低于旧样本时不会虚构重置事件。

## 验证与剩余边界

2026-10-22 补充：来源核对、重置提醒修正及组员数值差异的排查见 [A 修正与排查记录](A_FIX_20261022.md)。页面和显式 `--details` 诊断输出新增脱敏账号（例如 `f***@e***`）、套餐、程序来源、自定义登录目录提示和各配额组的有限字段；原始邮箱、账号 ID、凭据及路径仍不输出。诊断字段不写入 D 的历史样本或游戏存档。

“真实额度”只表示由本机 Codex 接口返回，不保证它与另一个正在打开的客户端采用同一登录配置或配额组。主看板目前仍使用 `codex` 组，并要求完整的 5h / 周窗口；其他组只在来源详情中供对照，不能相加、平均或冒充主看板。接口未提供工作区 ID 时，页面明确提示隔离边界。

已验证 Windows 本机通过官方接口返回真实 5 小时 / 周额度和时间，并验证 Electron → preload → IPC → Codex 的完整通路。当前全仓 204 项自动检查通过（早期 A 交付时为 78 项），覆盖 RPC 握手、拆包、错误脱敏、超时、取消与立即重试、快照修改隔离、缺失窗口、账号 / 工作区变化、异常日期、速率断档、重置去重、缓存、轮询与空速度存档；本轮补充查找时限、RPC 请求碰撞和快照新鲜度回归。已通过类型检查及生产构建。另通过无网络页面验收（未登录、加载、成功、旧数据、来源偏好、模拟存档隔离、迟到结果、退出登录、浏览器模式、获焦 / 联网刷新）。`npm run test:ui` 可复现；真实冒烟直接等待主页面显示 fresh，而不是额外发起一条读取。本轮记录以 [A 修正与排查记录](A_FIX_20261022.md) 为准，[A 模块复核报告](A_REVIEW.md) 保留为历史验收记录。

未完成：另一台电脑完整的休眠 / 断网 / 账号切换验收、成品 EXE 打包；其他 AI 平台、远程查看、内置账号登录、精确 Token / 金额账单也不在本模块范围内。组员“安装后正常”的反馈已经记录，不推断此前额度差异的根因。

接口依据：[OpenAI Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)。升级 Codex 后如协议变化，应重新运行契约测试和真实读取验证，不能对未知字段补模拟值。

桌面预加载构建依据：[Electron ESM 文档](https://www.electronjs.org/docs/latest/tutorial/esm)。保留 `preload.ts` 源文件，主进程加载构建出的 `preload.cjs`；不要改回直接加载包含 ESM import 的 `preload.js`。
