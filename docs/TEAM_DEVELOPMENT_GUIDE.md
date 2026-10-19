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

主要任务：

- 研究可以读取 Codex 额度的方式。
- 获取 5h 额度剩余比例。
- 获取周额度剩余比例。
- 获取两种额度的重置时间。
- 定期刷新额度数据。
- 获取失败时自动退回模拟数据。
- 不让真实数据读取失败导致程序崩溃。

主要文件：

```text
src/types/usage.ts
src/usage/UsageProvider.ts
src/usage/MockUsageProvider.ts
```

建议新增：

```text
src/usage/CodexUsageProvider.ts
src/usage/FallbackUsageProvider.ts
src/usage/providerFactory.ts
```

A 需要实现现有接口：

```ts
interface UsageProvider {
  getCurrentUsage(): Promise<UsageState>;
}
```

输出数据必须符合：

```ts
interface UsageState {
  shortWindowRemaining: number;
  weeklyRemaining: number;
  shortWindowResetAt: Date;
  weeklyResetAt: Date;
  burnRate: number;
  baselineBurnRate: number;
  sampledAt: Date;
  recentResetType: "short" | "weekly" | null;
}
```

注意：

- 剩余比例统一使用 `0–100`。
- Provider 不负责修改页面。
- 不要直接大规模修改 `App.tsx`。
- A 完成数据模块后，由 C 接入主程序。
- 如果无法稳定读取真实数据，必须保留 Mock Provider 作为演示保底。

验收标准：

- 能返回合法的 `UsageState`。
- 数据读取失败时不会白屏或崩溃。
- 可以切换“真实数据”和“模拟数据”。
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
interface TaskAnalysisInput {
  prompt: string;
  files: Array<{
    name: string;
    type: string;
    size: number;
  }>;
}

interface TaskAnalysisResult {
  taskType: string;
  complexity: "low" | "medium" | "high";
  estimatedInputTokens: {
    min: number;
    max: number;
  };
  estimatedOutputTokens: {
    min: number;
    max: number;
  };
  optimizedPrompt: string;
  canRunInParallel: boolean;
  parallelPlan: string[];
  warnings: string[];
}

interface TaskAnalyzer {
  analyze(input: TaskAnalysisInput): Promise<TaskAnalysisResult>;
}
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
- 输出中应明确写“估算结果”，不能伪装成精确 Token 账单。
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

宠物配置建议：

```ts
interface PetDefinition {
  id: string;
  name: string;
  spriteUrl: string;
  frameWidth: number;
  frameHeight: number;
}
```

场景配置建议：

```ts
interface SceneDefinition {
  id: string;
  name: string;
  backgroundUrl: string;
  themeClass: string;
}
```

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

建议的数据结构：

```ts
interface UsageSample {
  id: string;
  sampledAt: string;
  shortWindowRemaining: number;
  weeklyRemaining: number;
  burnRate: number;
}

interface UsageReport {
  startAt: string;
  endAt: string;
  sampleCount: number;
  averageBurnRate: number;
  peakBurnRate: number;
  activePeriods: string[];
  shortQuotaPressureCount: number;
  weeklyQuotaPressureCount: number;
  suggestions: string[];
}
```

建议第一版周报显示：

- 本周记录了多少次数据。
- 平均消耗速度。
- 最高消耗速度。
- 使用最集中的时间段。
- 5h 额度紧张次数。
- 周额度紧张次数。
- 使用节奏属于均衡、偏快还是保守。
- 下周使用建议。

月报可以先做示意页面，不要求真的积累一个月数据。

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

A 如果尚未完成真实读取，先提交 Provider 结构和模拟回退机制，不能阻塞整个项目。

### 10 月 26 日：集成与打包

- 检查所有入口。
- 检查真实数据与 Mock 切换。
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
