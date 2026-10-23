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
- C 接入新皮肤时必须同步改造 Pet.tsx 的固定帧表、背景尺寸和人物名称，不能只替换图片 URL。本次仅冻结配置类型，尚未实现换皮渲染器和选择界面。
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

### 修改的模块

- `src/types/taskAnalysis.ts`
- `src/task-analysis/`
- `src/components/TaskAnalysisPanel.tsx`
- `src/App.tsx`
- `src/styles.css`

### 测试方法

1. 测试空 Prompt、无文件、超长 Prompt 和非法文件元信息，确认返回结构化错误且页面不会崩溃。
2. 测试单文件、多文件以及代码文件、PDF、图片文件，确认任务类别、复杂度和 Token 区间会受到影响。
3. 测试多个编号任务和存在前后依赖的 Prompt，确认分别生成并行或串行建议。
4. 手动打开任务分析入口，验证面板自动展开、文件选择、结果展示、关闭和拖拽隔离。

### 检查结果

- [x] `pnpm typecheck` 通过
- [x] `pnpm build` 通过
- [x] `pnpm dev` 可以正常运行
- [x] 契约测试通过（10/10）
- [x] 没有提交账号、Token 或其他敏感信息
- [x] 原有功能没有明显损坏

### 尚未解决的问题

- 当前 Token 估算是基于 Prompt 和文件元信息的启发式结果，不是真实 Tokenizer 计数。
- 当前版本不读取附件内容，图片、PDF 和二进制文件的估算存在额外不确定性。
- 后续可以增加更完整的任务依赖分析、真实文件解析以及单元测试和组件测试。

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


D v4 已提供 `recommendTaskPlan(pendingTask, taskRecords, modelCapacities, now)` 及对应页面。B 可直接传入待办条件与各模型当前资源，获取同一任务的模型 / 时间方案。详见 `docs/D_UNIFIED_PLAN.md`。执行前仍需重新确认资源，不能把 recheck 当成确定排期；D 不负责自动调用或队列资源预留。

D v5 增加事后评价日志、独立推荐历史、能力约束、显式指定模型和有来源的价格估算。新方法 appendTaskEvaluations / queryTaskEvaluations 已接入 Electron 与浏览器；TaskRecord 原始调用仍不可变。任务账本写入 version=2，读取 version=1 兼容。组员按 docs/D_V5_IMPROVEMENTS.md 与 D_TASK_LEDGER.md 合并接线；不能只复制 reports 目录。


D v6 要求 TaskLedger 同时实现 writeExecutionEvent / queryExecutions / reconcileExecutions，并合并 3 个新 IPC 与执行日志 schema/store。旧记录器适配器未接日志时会在付费调用之前拒绝运行。TASK_PERSISTENCE_FAILED 只能重试保存，不能自动重新运行调用；结束记录可由界面补存。模型稳定配置按匿名账号隔离保存，余额/资源确认每次重新输入。详见 docs/D_V6_RELIABILITY.md 与 D_TASK_LEDGER.md。
