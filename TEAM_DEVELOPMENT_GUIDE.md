# PetCast 团队开发操作指南

## 1. 项目目标

PetCast 是一个 Windows 桌面宠物与 AI 额度使用情况分析工具。

10 月 27 日 Demo 版本需要完成：

1. 读取真实 Codex 额度使用情况。
2. 分析用户提交的 Prompt 和文件，估算任务规模与 Token 消耗。
3. 给出 Prompt 优化和任务并行建议。
4. 支持更换宠物形象和场景。
5. 保存额度历史，生成周报、月报示意与使用习惯建议。
6. 打包为可以安装或直接运行的 Windows EXE。
7. X/Tibo 重置预告暂时继续使用模拟数据。

项目仓库：[https://github.com/pro-software-20/PetCast](https://github.com/pro-software-20/PetCast)

## 2. 团队分工

### A：真实 Codex 数据

负责把当前模拟额度替换成真实数据。

2026-10-22 状态：真实读取及主页面接入已实现；组员反馈安装后额度正常。当前补充来源核对、查找超时与取消、RPC 响应区分和超龄快照保护，见 [A 修正与排查记录](docs/A_FIX_20261022.md)。此处任务清单是职责约定，不表示所有项仍待开发；B、C 分工及其原有代码继续保留。

主要任务：

- 研究可以读取 Codex 额度的方式。
- 获取 5h 额度剩余比例。
- 获取周额度剩余比例。
- 获取两种额度的重置时间。
- 定期刷新额度数据。
- 获取失败时保留上次真实快照并标记过期；没有缓存时显示不可用。
- 模拟演示由用户明确选择，不能自动用模拟数字冒充真实额度。
- 不让真实数据读取失败导致程序崩溃。

主要文件：

```text
src/types/usage.ts
src/usage/UsageProvider.ts
src/usage/MockUsageProvider.ts
```

本轮已新增（接入说明见 `docs/A_CODEX_USAGE.md`）：

```text
src/usage/CodexUsageProvider.ts
src/usage/providerFactory.ts
```

A 需要实现现有接口：

已有 `src/usage/UsageReader.ts` 统一处理读取校验、超时和旧快照回退，不再新增自动混用真实/模拟数据的 FallbackUsageProvider。

```ts
interface UsageProvider {
  readonly source: 'real' | 'mock';
  getCurrentUsage(signal?: AbortSignal): Promise<UsageState>;
}
```

输出数据必须符合：

```ts
interface UsageState {
  scopeId?: string; // 真实 Provider 必定提供；本地匿名账号作用域
  shortWindowRemaining: number;
  weeklyRemaining: number;
  shortWindowResetAt: Date;
  weeklyResetAt: Date;
  burnRate: number | null; // 百分点/小时；null 表示数据不足
  baselineBurnRate: number | null; // 同口径历史基准，不是 Token/小时
  sampledAt: Date;
  recentResetType: "short" | "weekly" | null;
}
```

注意：

- 剩余比例统一使用 `0–100`，数字必须有限，时间必须为有效 `Date`。跨 IPC / JSON 使用 UTC ISO 8601 字符串，进入业务层时显式还原。
- 两个额度窗口仍要求完整可用；缺失或无授权时拒绝返回，不能填 0 或模拟值。速度字段允许 `null`，首次采样、重置、额度上调或间隔超过 5 分钟均表示数据不足。现有分析、游戏和存档已同步处理空速度。
- `burnRate` 使用同一账号、同一短窗口的连续采样，按实际时间差计算消耗百分点/小时。首次采样或跨重置时无法可靠计算，应明确数据不足；不得把额度百分比当 Token 账单。
- `sampledAt` 是源数据的实际采样时间，读取缓存不能刷新它。`UsageReader` 另记 `checkedAt`，返回 `fresh/stale/unavailable`。
- `recentResetType` 仅在确认窗口发生重置时产生。真实模式倒计时到点只触发重新查询，不能照搬 Mock 自动补满逻辑。
- Provider 实现必须响应 AbortSignal。`UsageReader` 负责超时和错误封装，页面按请求完成后再等待 30 秒轮询；不在 Provider 内叠加无界重试。
- 每个 Provider/账号使用独立 UsageReader。切换来源时重建 Reader、清空旧视图或显示加载状态，不跨来源使用缓存。
- Provider 不负责修改页面。
- 不要直接大规模修改 `App.tsx`。
- A 完成数据模块后，由 C 接入主程序。业务只依赖 `UsageProvider`；`setScenario/update` 属于独立 Mock 控制，不加入真实 Provider 接口。
- C 在真实模式关闭 Mock 控制台，不把游戏存档中的模拟额度写回真实 Provider，也不在首次读取前显示默认模拟数字。
- A 已通过 Codex App Server 验证本机真实读取，并封装主进程与 preload 通道；只暴露经过校验的额度结果，不传凭据。用户安装 PetCast 后读取自己的本地 Codex 登录。主页面接入、来源设置、失败与旧数据展示已完成；请 C 合并时保留这些逻辑。组员反馈安装后正常，最终安装包与另一台电脑的完整异常验收仍待完成。
- 页面快照超过 90 秒或检测到时钟回退后不得继续显示 fresh，也不得触发额度提醒、重置效果或新历史记录。恢复可见、获焦、联网时重新读取；新响应通过校验后才恢复。来源详情的诊断字段只用于核对，不持久化进 D 的历史。
- 如果无法稳定读取真实数据，保留 Mock Provider 供用户明确选择演示；不得静默回退为模拟额度。

验收标准：

- 能返回合法的 `UsageState`。
- 数据读取失败时不会白屏或崩溃。
- 可以切换“真实数据”和“模拟数据”。页面已提供来源选择、读取中、失败与旧数据状态，本机页面验收通过；跨用户设备验收仍待完成。
- `pnpm typecheck` 和 `pnpm build` 通过。

### B：任务分析与 Prompt 优化

负责分析用户输入的任务、Prompt 和文件信息。

主要任务：

- 接收用户输入的 Prompt。
- 接收文件名称、类型、大小等信息。
- 判断任务类型和复杂度。
- 估算大致 Token 消耗范围。
- 给出更省 Token 的 Prompt。
- 判断任务是否适合拆分。
- 给出串行或并行执行建议。

建议新增：

```text
src/types/taskAnalysis.ts
src/task-analysis/TaskAnalyzer.ts
src/task-analysis/HeuristicTaskAnalyzer.ts
src/task-analysis/promptOptimizer.ts
src/task-analysis/parallelPlanner.ts
src/components/TaskAnalysisPanel.tsx
```

建议接口：

```ts
// 唯一类型定义位于 src/types/taskAnalysis.ts，业务模块从该文件导入。
interface TaskAnalysisInput {
  prompt: string;
  files: Array<{ name: string; type: string; size: number }>;
}
// type 为 MIME，size 单位为字节；本版仅接收元信息，没有读取文件内容。
// TaskAnalysisResult 保留复杂度、Token 区间、优化文本、并行建议，
// 并补充 estimationBasis: 'heuristic-metadata' 与 assumptions: string[]。
// TaskAnalyzer.analyze 返回 TaskAnalysisOutcome：
// { ok: true, result } 或 { ok: false, code, message }。
// 空输入、非法文件大小、超长输入以结构化失败返回，UI 明确提示。
```

第一版不必追求精确预测，可以使用规则估算：

- Prompt 字符数量。
- 文件数量与文件大小。
- 是否包含代码、图片、PDF。
- 是否要求搜索、分析、修改和测试。
- 是否同时包含多个互不依赖的任务。

注意：

- 页面组件不能直接写复杂分析规则。
- 分析规则放在 `src/task-analysis/`。
- UI 只负责收集输入和展示结果。
- 输出中应明确写“基于 Prompt 和文件元信息的粗估”，不能暗示已经阅读附件，不能伪装成精确 Token 账单。
- 区间必须是非负整数且 min <= max；空 prompt 且无文件为 EMPTY_INPUT。输入上限由 B 配置并在界面说明，缺失文件元信息和非有限/负数字节数为 INVALID_FILE。
- `parallelPlan: string[]` 只展示建议，不能直接执行。`canRunInParallel=false` 时可以展示串行建议，文字必须解释依赖。
- 指定分析模型、紧急程度、模型优先级、人工改派、自动执行不是本轮规则分析模块的已实现功能。将来执行任务时再增加任务 ID、dependsOn、模型与授权字段。
- Prompt 优化不得删除用户约束；建议与原文对照，用户确认后才用于调用。
- B 不直接修改桌宠和河流页面。

验收标准：

- 输入 Prompt 后可以得到任务复杂度。
- 能显示 Token 消耗区间。
- 能生成优化后的 Prompt。
- 能给出并行建议。
- 空输入、超长输入和文件缺失时不会报错。
- `pnpm typecheck` 和 `pnpm build` 通过。

### C：宠物、场景、主程序整合与 EXE

负责视觉内容、桌面程序以及其他成员模块的最终接入。

2026-10-25 状态：已接入五宠形象、四款可调色外壳、河畔/小屋界面及宠物动画。主页按沙地/水域范围活动，低频换向并随机休息；小屋与形象页使用轻微呼吸待机。动画接入及验证见 [C 宠物动画记录](docs/C_PET_ANIMATIONS.md)。2026-10-26 已生成 Windows 10/11 x64、当前账号安装的未签名内部测试包，使用白色圆形外壳小猫图标；本机安装、重装、启动、真实额度只读查询和卸载检查通过，原快捷方式及存档保留；另一台 Windows 电脑验收仍待完成。打包与验收见 [C 安装包说明](docs/C_WINDOWS_INSTALLER.md)。 同日完成 0.1.1 界面更新：任务分析页与真实额度统一样式、放大字号并收纳可选设置，真实额度页增加返回主页的关闭按钮。按用户确认使用 `features/c-outlook` 上传代码并创建 PR，安装包以 GitHub 预发布提供下载；任务/额度业务逻辑保持原有实现。

主要任务：

- 支持更换宠物。
- 支持更换河边或房间场景。
- 保证桌宠拖动、展开和收起正常。
- 把 A、B、D 的模块接入主程序。
- 整理导航和页面入口。
- 处理 Electron 窗口与本地文件功能。
- 打包 Windows EXE。
- 进行最终演示测试。

主要负责文件：

```text
src/App.tsx
src/Pet.tsx
src/RiverScene.tsx
src/styles.css
src/components/
electron/main.ts
electron/preload.ts
public/assets/
package.json
```

建议新增：

```text
src/types/appearance.ts
src/appearance/petRegistry.ts
src/appearance/sceneRegistry.ts
src/components/AppearanceSettings.tsx
public/assets/pets/
public/assets/scenes/
```

宠物与场景配置以 `src/types/appearance.ts` 为唯一类型来源：

- PetDefinition 包含 id、name、spriteUrl、frameWidth、frameHeight、columns、rows 和 animations。
- animations 按 idle、drag-left、drag-right、wave、celebrate、tired、anxious、eat、sleep 等动作配置帧坐标和 frameMs。
- idle 必须存在且非空；其他动作缺失时退回 idle。坐标不可超过网格，帧间隔必须大于零。
- C 接入新皮肤时必须同步改造 Pet.tsx 的固定帧表、背景尺寸和人物名称，不能只替换图片 URL。C 已完成配置化换皮、形象设置与动画显示；每个动作可补充独立图集尺寸、循环图像和静态首帧，减少动态效果时使用静态首帧。
- SceneDefinition 包含 id、name、backgroundUrl、themeClass；场景变体要保留钓鱼、邮箱和房间的点击区域。
- AppearancePreferences 单独保存 version、petId、sceneId，读取时核对注册表，未知 ID 回退默认。由 C 实现独立存储，不覆盖游戏存档。
- “啃脑子”、睡眠等角色动作可扩展动作表，但分心事件来源与动作呈现分开，缺少动作仍可正常显示。

注意：

- C 是 `App.tsx` 的主要负责人。
- 其他成员尽量不要同时修改 `App.tsx`。
- A、B、D 先提供独立模块，C 再负责连接页面。
- 不能为了换皮破坏现有钓鱼、图鉴和存档。
- 素材路径统一放在 `public/assets/`。
- 最终 EXE 必须在另一台 Windows 电脑上测试。

验收标准：

- 可以选择至少两种宠物。
- 可以选择至少两种场景，或者提供一套完整的更换结构。
- 重启后保留用户选择。
- 桌宠可以拖动、展开和收起。
- 原有钓鱼、图鉴、邮箱和水族箱仍然可用。
- 可以生成可运行的 EXE。
- `pnpm typecheck` 和 `pnpm build` 通过。

### D：历史记录、周报、月报与习惯建议

负责保存额度快照并生成统计分析。

主要任务：

- 定时记录 Codex 额度状态。
- 保存历史使用数据。
- 计算每天或每周的使用变化。
- 生成周报。
- 制作月报示意。
- 根据使用节奏给出建议。
- 支持没有真实数据时使用 Mock 数据展示。

建议新增：

```text
src/types/usageHistory.ts
src/history/UsageHistoryStore.ts
src/history/usageMetrics.ts
src/reports/weeklyReport.ts
src/reports/monthlyReport.ts
src/reports/habitAdvisor.ts
src/components/UsageHistoryPanel.tsx
src/components/WeeklyReportPanel.tsx
```

数据结构统一从 `src/types/usageHistory.ts` 导入，不在各模块重复定义。

UsageSample 除原有字段外，保存 source、scopeId、shortWindowResetAt、weeklyResetAt。scopeId 是非敏感的账号/数据源作用域标识，不得存入 Token、Cookie 或邮箱。所有时间为 UTC ISO 8601。

UsageReport 显式记录 source、scopeId、timeZone、coverageMs、warnings；数据不足时平均和峰值可以为 null，不能用 0 冒充无消耗。

存储边界为 UsageHistoryStore（D 已实现浏览器存储，并同步完成桌面独立文件与 IPC 接入）：

```ts
appendUsageSample(sample: UsageSample): Promise<void>;
queryUsageSamples(query: {
  startAt: string; endAt: string; source: 'real' | 'mock'; scopeId: string;
}): Promise<UsageSample[]>;
clearUsageHistory(scope: { source: 'real' | 'mock'; scopeId: string }): Promise<void>;
```

原分工为 D 负责浏览器存储与纯统计函数、C 负责桌面存储。本轮为完成桌面验收，已同步实现 Electron 主进程文件存储和 preload 桥接；C 合并时保留该接线。现有 saveGame/loadGameSave 只保存游戏，不能复用来写历史。接口缺失时不能静默切到另一种存储。

统一规则：

- 只追加校验通过的 fresh 数据。真实和 Mock 按 source + scopeId 隔离查询；陈旧缓存不得当作新样本反复写入。
- 同作用域、同 sampledAt 幂等去重；查询区间为 [startAt, endAt)，按采样时间升序。
- 每个作用域最多保留 90 天、100,000 条，先剔除过期再保留最新记录。真实周报不合并演示数据；模拟月报标为示意。
- 独立历史文件使用版本号、字段校验、串行写入和临时文件原子替换。读取失败应与空历史区分，不自动覆盖原文件。
- 仅同一窗口且相邻间隔 <= 5 分钟的有效片段参与速率统计。额度增加、重置时间变化或长断档均断开片段，不计算跨重置消耗。
- 平均速度按有效片段时长加权，峰值取有效片段速度最大值。coverageMs 记录有效覆盖时长，断档写入 warnings。
- 短额度 <= 25%、周额度 <= 22% 为紧张。PressureCount 统计从非紧张进入紧张的次数，不是采样次数；首次样本/重置/断档只建立状态，不虚构进入事件。
- 活跃时段按明确 timeZone 对有消耗的有效片段分桶，不按样本数量推断。数据不足明确提示，额度百分点不能换算为精确 Token 或金额。

建议第一版周报显示：

- 本周记录了多少次数据。
- 平均消耗速度。
- 最高消耗速度。
- 使用最集中的时间段。
- 5h 额度紧张次数。
- 周额度紧张次数。
- 习惯证据是否充足、低额度持续时长、时段分布和带依据的趣味称号。
- 下周使用建议。

已提供自然月真实报告和独立月报示意，用户可选择月份或修改起止日期。月报包括月内分段趋势；真实报告按实际有效覆盖显示，不要求先积累满一个月。

当前入口：河边 → 使用历史与报告。通常每 3 分钟保存 fresh 快照，遇到窗口变化、压力边界或额度回升立即补记。周报默认周一至周日，用户可设置起止星期（含止日，可跨周）；月报默认自然月，均支持手动日期。规则建议按有效覆盖、低额度持续时长、按覆盖归一的时段消耗生成，不再使用 10/20 的固定速度好坏标签。习惯门槛为至少 3 个有效日期、6 小时，具体小时段还需 3 天、1 小时。实现见 `docs/D_USAGE_HISTORY.md`。

任务执行记录单独使用 `src/history/TaskLedger.ts` 与 `TaskExecutionRecorder.ts`，不要把 B 的分析估计当作真实调用。B/执行器需在实际调用后提供服务商 usage、费用依据、状态与时间；D 按任务完成时间归属报告并追溯调用。接入和字段口径见 `docs/D_TASK_LEDGER.md`。D 已自动从账本生成任务建议，模型推荐需要可选 evaluation 字段，时间评估需要 PendingTaskContext 与当前额度；见 `docs/D_TASK_ADVICE.md`。执行器无需另写同一套建议规则。

注意：

- 不要把历史数据直接塞进现有 `GameSaveV1`。
- 建议单独保存额度历史，避免存档越来越大。
- 报告生成函数必须与 React 页面分离。
- D 可以先使用 `MockUsageProvider` 产生的数据开发。
- 等 A 完成后，同样的数据结构可以直接接收真实数据。

验收标准：

- 可以持续记录使用快照。
- 重启后历史记录仍然存在。
- 能生成周报。
- 能显示月报示意。
- 数据不足时显示明确提示。
- `pnpm typecheck` 和 `pnpm build` 通过。

## 3. 第一次下载项目

### 3.1 安装环境

需要安装：

- Git
- Node.js
- pnpm
- Visual Studio Code，或其他代码编辑器

确认安装成功：

```powershell
git --version
node --version
pnpm --version
```

如果电脑没有 pnpm：

```powershell
npm install -g pnpm
```

### 3.2 克隆仓库

在希望保存项目的位置打开 PowerShell：

```powershell
git clone https://github.com/pro-software-20/PetCast.git
cd PetCast
pnpm install
```

启动项目：

```powershell
pnpm dev
```

正常情况下会打开 PetCast 桌面窗口。

## 4. GitHub 权限

仓库公开并不代表所有人都可以推送代码。

负责人需要在 GitHub 仓库中进入：

```text
Settings
→ Collaborators and teams
→ Add people
```

把组员加入仓库。组员收到邀请后，需要先接受邀请，否则执行 `git push` 时会提示没有权限。

## 5. 认领任务后创建分支

任何人都不要直接在 `main` 分支开发。

四个角色分别使用：

```text
feature/a-codex-provider
feature/b-task-analysis
feature/c-desktop-package
feature/d-usage-reports
```

例如 A 创建自己的分支：

```powershell
git switch main
git pull origin main
git switch -c feature/a-codex-provider
```

第一次把分支上传到 GitHub：

```powershell
git push -u origin feature/a-codex-provider
```

其他成员只需要把最后一行的分支名换成自己的。

## 6. 每次开始工作前

打开项目目录，然后执行：

```powershell
git status
git switch 自己的分支名
git pull origin 自己的分支名
```

然后获取主分支最新代码：

```powershell
git fetch origin
git merge origin/main
```

如果出现冲突，不要随便删除别人的代码。先联系修改过相关文件的人。

## 7. 每完成一个小功能后

先查看改动：

```powershell
git status
git diff
```

运行检查：

```powershell
pnpm typecheck
pnpm build
```

两个命令都成功后，再提交：

```powershell
git add 具体文件路径
git commit -m "feat: 完成功能说明"
git push
```

提交示例：

```powershell
git add src/usage/CodexUsageProvider.ts
git commit -m "feat: add Codex usage provider"
git push
```

不要把以下内容提交到仓库：

- `node_modules`
- `dist`
- `dist-electron`
- API Key
- 登录 Cookie
- Token
- `.env`
- 包含个人账号信息的文件

## 8. Commit 信息格式

建议使用：

```text
feat: 新增功能
fix: 修复问题
refactor: 重构代码
docs: 修改文档
test: 新增测试
chore: 修改配置或构建
style: 修改界面样式
```

示例：

```text
feat: add real Codex usage provider
feat: add weekly usage report
fix: prevent fishing button from becoming unresponsive
style: add pet selection panel
chore: configure Windows packaging
```

一次 Commit 尽量只做一类事情。

## 9. 提交 Pull Request

功能完成并推送后：

1. 打开 GitHub 仓库。
2. 点击 `Pull requests`。
3. 点击 `New pull request`。
4. `base` 选择 `main`。
5. `compare` 选择自己的分支。
6. 填写功能说明和测试结果。
7. 创建 Pull Request。
8. 请至少一名组员检查后再合并。

Pull Request 模板：

```md
## 完成内容

-

## 修改的模块

-

## 测试方法

1.
2.
3.

## 检查结果

- [ ] pnpm typecheck 通过
- [ ] pnpm build 通过
- [ ] pnpm dev 可以正常运行
- [ ] 没有提交账号、Token 或其他敏感信息
- [ ] 原有功能没有明显损坏

## 尚未解决的问题

-
```

## B 模块完成记录

### 完成内容

- 完成任务分析输入、输出和错误处理接口设计。
- 实现 `HeuristicTaskAnalyzer`，根据 Prompt、文件数量、文件类型和操作类型判断任务类别、复杂度和 Token 区间。
- 实现 `promptOptimizer` 和 `parallelPlanner`，生成结构化 Prompt 以及串行/并行执行建议。
- 实现 `TaskAnalysisPanel`，支持 Prompt 输入、多个文件元信息录入、文件删除、结果展示和异常提示。
- 在 `App.tsx` 中接入任务分析入口，并实现与钓鱼、小屋和邮箱面板的互斥显示。
- 完成 P1 第一阶段体验优化：限制文件数量与大小、提示重复或超限文件、复制优化 Prompt，并提供双确认清空。
- 完成 P1 第二阶段：增加可替换的异步 Prompt 优化器、DeepSeek 团队服务、受限 IPC、自动本地回退和优化来源提示。
- 增强论文、文章、写一篇和选题等中文写作识别；本地回退按写作、研究、编程、分析和测试生成差异化 Prompt。

### 修改的模块

- `src/types/taskAnalysis.ts`
- `src/task-analysis/`
- `src/components/TaskAnalysisPanel.tsx`
- `src/App.tsx`
- `src/styles.css`
- `tests/task-analysis.test.mjs`
- `electron/promptOptimizationProtocol.ts`、`electron/promptOptimizationClient.ts`、`electron/promptOptimizationIpc.ts`
- `server/`、`tests/prompt-optimization.test.mjs`、`tests/prompt-optimization-ipc.test.mjs`

### 测试方法

1. 使用 `tests/task-analysis.test.mjs` 自动测试空 Prompt、无文件、超长 Prompt 和非法文件元信息，确认返回结构化错误且页面不会崩溃。
2. 测试单文件、多文件以及代码文件、PDF、图片文件，确认任务类别、复杂度和 Token 区间会受到影响。
3. 测试多个编号任务和存在前后依赖的 Prompt，确认分别生成并行或串行建议。
4. 测试 Prompt 优化的空白清理、文件列表和空 Prompt 模板，并检查所有 Token 区间均为非负有序整数。
5. 手动打开任务分析入口，验证面板自动展开、文件选择、MIME 缺失错误、旧结果清理、关闭和拖拽隔离。
6. 测试 20 个文件、100 MiB 单文件和 500 MiB 总大小边界，并覆盖重复文件及多种拒绝原因。
7. 手动验证复制反馈、复制兼容回退、双确认清空和分析中清空不会恢复旧结果。
8. 使用伪造 DeepSeek 响应测试成功、超时、限流、非法 JSON、本地回退和错误脱敏，不在自动测试中消耗真实 API。
9. 测试 Electron IPC 与 HTTP 服务只转发 Prompt 和文件元信息，额外字段与文件内容不会穿过边界。
10. 测试匿名安装标识、IP 和全局限流；持久化文件只保存 HMAC 标识，不保存原始 IP 或安装标识。

### 检查结果

- [x] `pnpm typecheck` 通过
- [x] `pnpm build` 通过
- [x] `pnpm dev` 可以正常运行
- [x] `pnpm test:contracts` 契约测试全部通过
- [x] 没有提交账号、Token 或其他敏感信息
- [x] 原有功能没有明显损坏
- [x] DeepSeek 未配置或不可用时仍可完成本地任务分析

### 尚未解决的问题

- 当前 Token 估算是基于 Prompt 和文件元信息的启发式结果，不是真实 Tokenizer 计数。
- 当前版本不读取附件内容，图片、PDF 和二进制文件的估算存在额外不确定性。
- 后续可以增加更完整的任务依赖分析、真实文件解析以及自动化组件交互测试。
- DeepSeek Prompt 优化会把 Prompt 和文件元信息发送到团队服务，但不会读取或上传附件内容；其 API 消耗不属于 Codex/ChatGPT 额度。
- 当前公网方案是匿名限流测试版，只适合公开 Demo。正式商业发布前需要用户认证、多实例共享限流、HTTPS、持久化存储和服务端消费上限。
- `PETCAST_PROMPT_API_URL` 未配置时直接使用本地优化；DeepSeek Key 只允许保存在团队服务端环境变量中，不能进入 React、preload、Git 或 EXE。
- 本机效果验证可在被 Git 忽略的 `.env.local` 中配置 `DEEPSEEK_API_KEY`，然后运行
  `pnpm dev:ai`。该命令只在 `127.0.0.1` 启动 Prompt 服务，不用于公网发布。

## 10. 文件修改范围

为了避免四个人同时修改同一文件：

| 角色 | 主要修改范围 | 尽量不要直接修改 |
|---|---|---|
| A | `src/usage/`、`src/types/usage.ts` | `App.tsx`、样式和宠物组件 |
| B | `src/task-analysis/`、任务分析组件 | 使用额度 Provider、Electron |
| C | `App.tsx`、Electron、宠物、场景、样式、打包 | A、B、D 的内部算法 |
| D | `src/history/`、`src/reports/`、报告组件 | Electron、宠物和钓鱼逻辑 |

如果确实需要修改其他成员负责的文件，先在群里说明。

## 11. 模块接入规则

A、B、D 应先完成独立模块，不要把所有逻辑直接写进 `App.tsx`。

正确方式：

```text
输入数据
   ↓
独立 TypeScript 模块
   ↓
返回结构化结果
   ↓
React 组件展示
   ↓
C 接入 App.tsx
```

例如 D 的周报函数：

```ts
const report = generateWeeklyReport(samples);
```

函数返回数据，页面只负责显示。不要在页面组件里同时进行数据抓取、数据分析、文件读写、复杂业务判断和页面渲染。

## 12. 建议开发顺序

### 10 月 20 日：准备与认领

- 所有人克隆仓库并运行项目。
- 确认 GitHub 推送权限。
- 创建各自分支。
- 确认接口和文件修改范围。

### 10 月 21–23 日：并行开发

- A 完成真实数据读取的最小版本。
- B 完成 Prompt 分析与估算规则。
- C 完成宠物/场景配置结构并研究 EXE 打包。
- D 完成历史数据结构和周报生成函数。

### 10 月 24 日：模块自测

每个成员必须确保：

```powershell
pnpm typecheck
pnpm build
pnpm dev
```

全部正常。

### 10 月 25 日：合并模块

建议合并顺序：

1. B：任务分析模块。
2. D：历史记录与报告模块。
3. A：真实 Codex 数据模块。
4. C：统一接入页面并处理冲突。

A 如果尚未完成真实读取，先提交 Provider 结构、失败状态与显式模拟模式，不能阻塞整个项目。

### 10 月 26 日：集成与打包

- 检查所有入口。
- 检查真实数据与 Mock 切换，失败时不冒充真实数据。
- 检查冷启动失败、超时、过期缓存、跨重置、重复采样、历史数据隔离和皮肤缺失动作。
- 检查存档。
- 检查桌宠模式。
- 生成 EXE。
- 换一台 Windows 电脑测试。
- 准备 Demo 数据。

### 10 月 27 日：课堂展示

展示顺序建议：

1. 打开桌宠。
2. 展示实时额度。
3. 展示河流随额度变化。
4. 输入一个任务 Prompt。
5. 展示 Token 估算与优化建议。
6. 展示任务并行计划。
7. 展示历史数据与周报。
8. 更换宠物或场景。
9. 简单展示钓鱼、图鉴和水族箱。
10. 说明 X 数据暂时使用 Mock Provider。

## 13. 出现问题时怎么处理

### `pnpm install` 失败

先检查：

```powershell
node --version
pnpm --version
```

然后重新运行 `pnpm install`，不要把别人电脑上的 `node_modules` 复制过来。

### 无法推送

检查：

```powershell
git branch --show-current
git remote -v
```

常见原因包括没有接受 GitHub 邀请、没有写入权限、登录了错误账号，或者正在向 `main` 推送。

### 合并冲突

执行：

```powershell
git status
```

把冲突文件和涉及成员发到群里，共同确认保留哪些代码，不要直接删除别人的修改。

### 修改后程序无法运行

依次执行：

```powershell
pnpm typecheck
pnpm build
pnpm dev
```

把完整错误信息发给负责该模块的成员，不要只发“运行不了”。

## 14. 完成定义

一个功能只有满足以下条件才算完成：

- 功能可以实际操作。
- 错误输入不会让程序崩溃。
- 不影响现有钓鱼、图鉴、邮箱和水族箱。
- 没有提交密钥或个人信息。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- 已推送到个人分支。
- 已创建 Pull Request。
- Pull Request 中写明测试方法。

## 15. B 模块 P0：多 AI 任务编排契约

本阶段只建立多 AI 编排的公共契约和严格校验，不会直接执行任务，也不会把现有的 `parallelPlan` 展示建议当作可执行任务图。

- `src/types/taskOrchestration.ts` 定义 Provider、任务图、文件范围、运行状态和执行结果。
- `src/orchestration/BrainProvider.ts`、`WorkerProvider.ts` 和 `QuotaProvider.ts` 定义可替换 Provider 接口，接口中不保存密钥。
- 附件引用只包含文件元信息；可写、禁止和输出位置必须使用工作区相对路径。
- `taskPlanValidation.ts` 检查任务 ID、Provider、路径安全和 DAG 依赖，不接受循环、未知依赖或路径穿越。
- P1 再实现实际任务拆解和人工任务卡；P0 不新增调度、持久化、UI、API 调用或文件写入。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 16. B 模块 P1：本地任务拆解与人工 AI 任务卡

本阶段在 P0 契约之上增加本地大脑和人工分发界面，但仍不会自动调用或控制 Codex、DeepSeek、豆包。

- `LocalBrainProvider` 优先识别编号任务和显式依赖；没有明确子任务时，按任务类型生成保守的阶段模板。
- 所有任务计划都经过 `validateTaskPlan()` 校验，执行模式固定为 `manual`。
- 编程与测试默认推荐 Codex，研究与分析默认推荐 DeepSeek，写作与润色默认推荐豆包；不可用时回退本地规则。
- 浏览器附件只转换为名称、MIME 和大小，不读取内容，也不伪造工作区路径。
- 未提供真实工作区授权时，可修改路径和输出位置保持为空，任务卡明确提示先由用户确认。
- 每张任务卡可单独切换 AI 并复制专属 Prompt；切换只影响复制文本，不修改已经校验的静态任务图。
- 修改 Prompt、增删文件或清空输入会取消旧请求并移除旧计划，迟到结果不会覆盖当前输入。
- 分析成功但拆解失败时保留分析结果，并单独展示安全错误信息。
- P1 不记录执行中、完成或失败状态，不持久化任务，不生成最终报告；这些能力留给 P2。
- P1 不读取或使用额度数据；通用额度适配由负责 P3 的成员单独接入。

自动测试覆盖编号拆分、串并行依赖、各任务类型模板、Provider 推荐与回退、附件数据边界、取消和异常结果，以及四种人工复制 Prompt。验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 17. B 模块 P2：人工执行闭环与任务报告

P2 在人工任务卡基础上增加本地运行状态、结果回收、进度恢复和最终报告，仍不自动调用或控制外部 AI。

- 成功复制任务 Prompt 后进入“进行中”；用户粘贴结果并逐项填写验收状态。
- 任务必须经过“待验收”，且所有验收项均通过后才能完成和解锁依赖任务。
- 支持等待信息、继续、退回修改、失败、取消和重试；Provider 只能在任务开始前切换。
- 后续任务 Prompt 只带入已完成前置任务的结果摘要，不包含完整返回正文。
- `TaskSessionV1` 将静态任务图与运行记录分离，所有状态更新通过纯函数和严格校验完成。
- 最近一次会话保存在独立的 `petcast.task-session.v1` 本地存储中，不写入游戏存档。
- 单个结果最多 50,000 字符，整个会话最多 2 MiB；损坏记录不会被静默覆盖。
- 未完成会话自动恢复；已完成会话可重新查看报告，新建任务需要二次确认。
- 全部任务和最终验收通过后，本地生成可复制、可下载的 Markdown 摘要报告。
- P2 不使用额度数据、不执行文件修改，也不调用 `WorkerProvider.execute()`。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 18. B 模块 P2.1：并行依赖图与人工依赖调整

P2.1 修正了自动拆解任务全部串行等待的问题，并保留确实需要前置结果的阶段依赖。

- 编号任务默认作为独立根任务；依赖词只作用于对应任务，不再把整个计划自动串成一条链。
- “并行、同时、分别、独立、互不依赖”等描述会保留并行分支；明确引用任务编号时建立对应依赖。
- 所有无前置依赖的任务同时进入“已就绪”，完成一个分支不会阻塞其他独立分支。
- 汇总任务只有在它声明的所有前置任务都完成并验收后才会解锁。
- 用户可以在首次执行前为每张任务卡选择前置任务；只能选择排在当前任务之前的任务。
- 任一任务复制并开始后，整个依赖图锁定，避免运行过程中改变已生成 Prompt 的上下文。
- 重复、自身、未知、后序和循环依赖会被拒绝，修改后的依赖随任务会话保存和恢复。
- 本阶段仍为人工复制与人工验收，不自动调用 AI，也不读取或修改额度数据。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 19. B 模块 P2.2：按子任务智能推荐 AI

P2.2 将 Provider 推荐从“沿用整个任务类型”升级为“逐个子任务判断”，不会为了看起来多样而强行分配不同 AI。

- 每个子任务独立识别方案规划、代码实现、测试验证、资料研究、分析推理、内容写作、复核润色、视觉理解和通用任务。
- 编程实现、项目文件修改和可执行测试优先 Codex；研究、分析和方案设计优先 DeepSeek；中文写作、润色和视觉任务优先豆包。
- 测试方案设计与实际运行测试分开推荐；“修改 README”等文件操作与单纯撰写文案也会区别处理。
- 文件名称、MIME 和类型只作为辅助信号，仍不读取或上传附件内容。
- 新任务计划保存推荐类型、所需能力、中文理由和可信度；旧 P2/P2.1 会话没有这些字段时仍可恢复。
- 用户仍可在任务开始前人工改选 AI，改选只更新本次执行记录，不覆盖静态推荐依据。
- 首选 Provider 不可用时按能力匹配其他手动 Provider，仍无匹配时回退本地规则。
- 本阶段不读取额度、不自动调用 AI，也不修改 A/D 模块的推荐与执行记录逻辑。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 20. B 模块 P2.3＋P2.4：工作区授权与任务卡编辑

P2.3/P2.4 在人工任务卡开始执行前增加桌面端工作区授权和任务定义编辑，仍不读取或修改项目文件正文。

- Electron 只通过 `selectTaskWorkspace()` / `cancelTaskWorkspace()` 暴露受限文件夹选择，不向渲染层暴露任意文件读取 API。
- 工作区扫描仅返回统一为 `/` 的相对路径、类型和文件大小；跳过符号链接、版本库、依赖、构建产物和缓存目录，并限制为 2,000 项、12 层。
- 工作区 ID 使用安装级密钥对规范化根目录做 HMAC；会话只保存匿名 ID、显示名称和实际授权的相对路径，不保存绝对根目录或完整扫描清单。
- 每个任务可以分别设置输入文件、允许修改、禁止修改和输出位置；禁止范围优先，输出必须位于允许范围内且不能落入禁止范围。
- 输入文件只能来自本次扫描到的文件；尚不存在的新输出文件可手动填写经过安全校验的相对路径。
- 切换到不同工作区前需要二次确认，确认后清空旧工作区引用；重新选择同一工作区时保留授权。
- 任务开始前可以编辑标题、描述、核心 Prompt、交付物、验收标准和文件范围；保存时重新校验任务图并重新计算 AI 推荐。
- 用户已人工改选 AI 时，重新推荐不会覆盖人工选择；任一任务开始后，任务内容、依赖和文件授权统一锁定。
- 工作区清单不会进入 DeepSeek Prompt 优化请求；复制给执行 AI 的任务 Prompt 只包含工作区显示名称和用户授权的相对路径。
- 浏览器模式不提供不安全降级，只显示“工作区选择仅桌面版可用”。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 21. B 模块 P2.4.1：简化工作区文件授权

P2.4.1 将逐路径四按钮授权改为“全局默认＋任务微调＋目录树弹层”，降低大型项目中的配置成本。

- 工作区默认范围可一次应用到全部未开始任务，特殊任务仍可单独调整或恢复默认。
- 目录树按层级折叠展示，搜索结果保留父目录上下文；每次只编辑读取、修改、禁止或输出中的一类权限。
- 新增目录级只读范围；写入范围隐含可读，禁止范围始终优先，输出仍必须位于允许修改范围内。
- 旧 workspace 输入文件在用户重新保存授权时迁移为读取范围，浏览器附件不会被批量授权或工作区切换删除。
- 扫描自动忽略 `.android-tools`、`.gradle`、虚拟环境、Python 缓存、临时目录和日志目录。
- 大型目录未检测到常见项目标识时给出项目根目录提示，但不阻断用户继续使用。
- 文件内容、绝对路径和完整扫描清单仍不会写入会话、复制 Prompt 或发送给远程优化服务。
- 任一任务开始后，全局默认、任务授权、任务内容和依赖关系继续统一锁定。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
git diff --check
```

## 22. B 模块 P2.5：安全的单 Codex 自动执行试点

P2.5 只为 `coding` / `testing` 且选择 Codex 的已就绪任务提供桌面端自动执行；其他任务继续使用人工复制流程。

- 使用本机已登录的 Codex app-server，不在前端保存账号、Token 或 API Key。
- 页面必须持有 fresh 的真实账号作用域；执行前主进程再次读取账号并校验匿名作用域，不一致时拒绝调用。
- 工作区绝对路径仅在 Electron 主进程内存中保存，重启后必须重新选择同一工作区。
- Codex 只在临时隔离副本中运行，关闭网络并使用 `approvalPolicy=never`；同一时间只允许一个自动任务运行。
- 隔离输入最多 2,000 个文件、总计 50 MiB、单文件 2 MiB，仅接受 UTF-8 文本；符号链接、路径穿越和禁止范围会被拒绝。
- 删除、重命名、二进制或越权改动会使整次结果失败；原项目不会被自动修改。
- 执行完成后展示受限 diff；用户明确选择“应用改动”后，主进程才会重新校验原文件哈希并带回滚保护地写回。
- AI 返回的测试描述不能代替人工验收；应用或丢弃文件产物后，验收项仍保持“未执行”。
- 自动执行通过现有 `TaskExecutionRecorder` 先写执行意图再调用 Codex，并记录服务商上报的 Token；费用未知时保持 `null`。
- 执行日志保存失败后禁止自动重跑；重启时遗留的运行/产物状态转为“需要信息”，要求用户先核对账本。
- 会话只保存执行 ID、模型、状态、文件数量和安全状态，不保存完整 diff、绝对路径、文件正文或临时目录。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
git diff --check
```

## 22.1. B 模块 P2.5.1：Codex 真实联调与可靠性修复

本轮继续把 P2.5 作为本地桌面试验功能，不将本机登录复用描述为公开版 OAuth。正式面向所有用户发布前，仍需迁移到官方 Sign in with ChatGPT/OAuth、令牌刷新和注册配置。

- 准备阶段按 `requestId` 注册可取消操作；取消、关闭面板或切换会话会中止文件隔离和 app-server 初始化，并阻止迟到结果进入待执行状态。
- 待审核文件产物 30 分钟后失效，页面收到 `ARTIFACT_EXPIRED` 后会清除句柄并把任务转为“需要信息”，不会自动重跑。
- 应用成功与临时目录清理解耦：源文件已经安全写回时，首次清理失败不会误报“应用失败”，后台只进行有限重试。
- 丢弃失败保留产物供用户重试；主进程和 Renderer 的准备、读取、应用、丢弃异常均转换为结构化安全提示，不暴露绝对路径、stderr 或服务商正文。
- app-server 按本机 `codex-cli 0.163.0` 生成的 v2 协议校验；补齐 `initialize.capabilities`，并移除会导致当前 CLI 拒绝请求的冗余 `runtimeWorkspaceRoots` 覆盖。文件写入边界仍由隔离副本和 `sandboxPolicy.writableRoots` 强制限制。
- `turn/completed` 只接受首个终态；`failed`、`interrupted` 不会被迟到的 `completed` 覆盖。
- 执行确认页明确提示“使用本机 Codex 登录，仅供本地试验”；浏览器模式和执行器不可用时继续使用人工复制流程。

真实联调使用系统临时零依赖 ESM 项目，未写入 Git：

- 第一次调用暴露协议兼容问题，随后修复；按两次调用上限，第二次优先验证修复，取消链保留模拟测试覆盖。
- 第二次由 `gpt-5.6-luna` 修改 `src/calculator.mjs` 与 `tests/calculator.test.mjs`，未访问或修改禁止的 `private` 路径。
- 人为修改原始文件后应用返回 `SOURCE_CHANGED`；恢复原文件后安全应用成功，临时项目 `node:test` 通过。
- D 模块记录服务商上报的输入、缓存输入和输出 Token，费用保持 `null`；联调完成后隔离目录数量为 0。

本轮自动测试增加准备取消、迟到终态、产物过期、清理失败、应用后清理失败、IPC 异常脱敏及 review 状态中断覆盖。验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm check:codex
git diff --check
```

## 22.2. B 模块 P2.6.1：Codex 环境自检与人工回退

任务分析页在桌面版打开时自动检查本机 Codex 环境，不再通过“真实额度是否读取成功”间接判断自动执行能力。

- 自检检查 Codex CLI 是否存在、版本是否不低于 `0.163.0`，并通过短生命周期 app-server 核对 ChatGPT 登录和匿名账号作用域。
- 自检只调用只读账号接口，不创建线程、不启动 `turn`，因此不会产生推理 Token。
- 额度响应只用于取得账号工作区标识，不解析 5 小时或周额度窗口；额度页面失败不会单独禁用自动执行。
- Renderer 只接收版本、检查时间、结构化状态和安装级 HMAC 生成的匿名 `scopeId`，不会收到邮箱、账号 ID、Codex 路径、stderr 或凭据。
- 未安装、版本过低、未登录、账号类型不支持、超时和协议异常均显示对应处理建议，并始终保留人工复制 Prompt 流程。
- 浏览器模式明确提示自动执行仅桌面版可用；页面关闭、重新检查或导航时会取消旧检查，迟到结果不会覆盖新状态。
- 本机 Codex 登录复用仍属于本地试验能力；正式公开发行仍需另行接入官方 OAuth、令牌刷新和应用注册。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm check:codex
git diff --check
```

## 22.3. B 模块 P2.6.2：Continue with ChatGPT 与 OAuth 执行授权

P2.6.2 将公开版 Codex 自动执行的账号来源从“复用本机 Codex 登录”调整为用户明确触发的 **Continue with ChatGPT** 授权。

- Electron 主进程按 OpenAI 公开协议实现动态客户端注册、PKCE、`state` / `nonce`、回环回调、ID Token 校验、刷新令牌轮换和断开时的远程撤销。
- 系统安全存储不可用时拒绝持久化登录，不降级为明文存储。本机文件只保存密文与非敏感 host ID。
- Renderer 只获得连接状态、脱敏身份、匿名 `scopeId` 和安全错误码；访问令牌、刷新令牌、ID Token、完整邮箱和 OAuth 响应均不进入页面、任务会话或 D 模块日志。
- 自动执行前主进程取得当前有效 Token 并核对匿名账号作用域，然后仅通过 app-server 子进程的 `ACCESS_TOKEN` 环境变量传入；任务 IPC 不包含 Token。
- 旧的本机 Codex 登录复用仅在 `PETCAST_EXPERIMENTAL_LOCAL_CODEX_AUTH=1` 时启用，默认公开构建不使用该回退。
- 页面支持连接、取消登录、管理用量和断开连接；授权失败时 Codex 自动执行禁用，人工复制 Prompt 始终可用。
- 当前实现使用 MIT 许可的 `jose` 做 OIDC/JWT 验证，没有复制非 MIT 开发包代码；仓库增加 MIT `LICENSE`。

自动测试覆盖加密持久化、脱敏返回、刷新令牌轮换、作用域不匹配、取消/超时、撤销、可信主 frame IPC、OAuth 环境自检和 Token 主进程注入。正式发布前还需完成 OpenAI 应用注册、隐私政策、多电脑登录和安装包验收。

### P2.6.2.1：授权错误恢复

真实联调已确认系统浏览器可以返回本机回环地址，但首次动态注册后的 Token 交换仍可能失败；完整真实账号验收延期到支持环境补测。本轮只完善安全恢复，不自动重复 OAuth，也不绕过地区或账号策略：

- 回调页只确认“授权结果已收到，PetCast 正在完成验证”，不在 Token 交换和 ID Token 校验完成前宣称登录成功。
- `invalid_grant` 映射为“首次注册已完成，请重新授权”，保留已加密保存的签发客户端 ID，并由用户手动开始新的授权流程。
- 地区限制、无效客户端、网络异常和畸形响应使用不同的安全错误码；Renderer 不接收授权 code、Token、完整服务端正文或完整账号身份。
- 授权失败时继续保留人工复制 Prompt；额度读取、D 任务账本、`App.tsx` 和游戏模块不参与本轮修改。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
git diff --check
```

## 22.4. B 模块 P2.7：端到端验收与收尾

P2.7 新增 `pnpm test:task-ui`，在隐藏 Electron 窗口中使用临时项目、临时存储和固定 IPC fixture 验证 B 模块完整闭环。测试主动拦截所有 HTTP/HTTPS 请求，不打开 OAuth 页面、不调用真实模型，也不产生推理 Token。

- 覆盖空输入、输入变化失效、混合任务拆解、逐任务 AI 推荐、并行根任务和局部依赖。
- 覆盖 OAuth 地区限制、Codex 不可用时的人工 Prompt 回退，以及人工结果、逐项验收和最终报告。
- 覆盖工作区目录授权、模拟 Codex prepare/run、受限 diff、应用改动和供应商 Token 账本记录。
- 覆盖未完成/已完成会话恢复、自动执行中断恢复和损坏存档的显式清理。
- 验收发现整页刷新不保证触发 React 卸载清理；任务执行 IPC 已增加 Renderer 导航/销毁取消，防止后台 Codex 继续运行。

本轮 365 项契约测试全部通过；详细验收矩阵、人工视觉检查和限制见 `docs/B_P27_ACCEPTANCE.md`。

## 22.5. B 模块 P2.8：任务编排界面收尾

2026-10-26 完成任务分析和人工编排界面的渐进式收纳：

- 生成或恢复任务方案后，输入与完整分析默认收成摘要栏；错误和新建任务会重新展开输入区。
- 任务卡改为单开式折叠布局，收起状态仍显示任务状态、所选 AI、依赖和下一步。
- 恢复会话时优先定位需要信息、待验收、进行中或已就绪的任务；完成任务后自动定位新解锁任务。
- 复制和执行入口优先展示，任务编辑、依赖和文件授权放入高级设置；全局授权范围默认折叠。
- 卡片标题支持 `aria-expanded` 和键盘操作，任务区按钮扩大点击区域，小窗口下不增加横向滚动。

`scripts/test-task-analysis-ui.mjs` 已补充摘要收纳、单卡展开、恢复定位、任务自动切换及高级设置检查；测试仍使用临时 fixture，禁止外部网络和真实模型调用。P2.8 不修改任务会话协议、状态转换、额度或游戏模块。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```

## 22.6. B 模块 P2.8.1：任务执行语义修复

P2.8.1 修复任务推荐、人工执行状态和 Codex 能力展示之间的语义混淆，不增加新的 AI 调用能力：

- “编写代码并测试”等实际开发任务推荐 Codex；测试方案设计仍推荐 DeepSeek，纯 React 结构设计与需要创建文件的实现任务分别处理。
- 复制任务 Prompt 只操作剪贴板，不再自动把任务标记为运行中；用户明确点击“已交给 AI，开始跟踪”后才进入 `running` 并锁定计划。
- ChatGPT 授权与 Codex 环境检查合并为默认折叠的“Codex 自动执行（可选）”区域，人工复制和任务跟踪不依赖该能力。
- 任务摘要明确显示“任务拆解：本地规则”，任务卡使用“子任务执行 AI”标签；真正的大脑切换留到 P2.9。

本轮保持任务会话协议、OAuth、Codex 自动执行、额度、账本和游戏模块不变。UI 验收覆盖复制成功和失败均不启动任务、显式开始跟踪、折叠状态展示及截图示例的四项 AI 推荐。

验证命令：

```powershell
pnpm test:contracts
pnpm typecheck
pnpm build
pnpm test:desktop
pnpm test:task-ui
git diff --check
```

## 23. D 模块后续接入说明

D v4 已提供 `recommendTaskPlan(pendingTask, taskRecords, modelCapacities, now)` 及对应页面。B 可直接传入待办条件与各模型当前资源，获取同一任务的模型 / 时间方案。详见 `docs/D_UNIFIED_PLAN.md`。执行前仍需重新确认资源，不能把 recheck 当成确定排期；D 不负责自动调用或队列资源预留。

D v5 增加事后评价日志、独立推荐历史、能力约束、显式指定模型和有来源的价格估算。新方法 appendTaskEvaluations / queryTaskEvaluations 已接入 Electron 与浏览器；TaskRecord 原始调用仍不可变。任务账本写入 version=2，读取 version=1 兼容。组员按 docs/D_V5_IMPROVEMENTS.md 与 D_TASK_LEDGER.md 合并接线；不能只复制 reports 目录。


D v6 要求 TaskLedger 同时实现 writeExecutionEvent / queryExecutions / reconcileExecutions，并合并 3 个新 IPC 与执行日志 schema/store。旧记录器适配器未接日志时会在付费调用之前拒绝运行。TASK_PERSISTENCE_FAILED 只能重试保存，不能自动重新运行调用；结束记录可由界面补存。模型稳定配置按匿名账号隔离保存，余额/资源确认每次重新输入。详见 docs/D_V6_RELIABILITY.md 与 D_TASK_LEDGER.md。
