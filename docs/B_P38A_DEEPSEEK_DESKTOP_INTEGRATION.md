# B-P3.8A：桌面端 DeepSeek 执行接入

## 范围

桌面端任务协调器现在会在受限 Electron preload 同时提供 `dispatchDeepSeekExecution`、`inspectDeepSeekExecution` 和 `cancelDeepSeekExecution` 时，注册 A 组的 DeepSeek API 执行适配器。浏览器构建仍使用空注册表；测试可继续显式注入内存适配器。

API Key 只从启动桌面应用进程时的本机 `DEEPSEEK_API_KEY` 环境变量读取。它不会传入 React、任务会话、协调存档、审计记录、导出文件或 Git。可选 `DEEPSEEK_MODEL` 仅用于选择模型。

## 本机单次验收

1. 推荐在项目根目录的、被 Git 忽略的 `.env.local` 中保留本机 Key，然后启动本机 AI 版本：

   ```powershell
   pnpm dev:ai
   ```

   `dev:ai` 会读取 `.env.local` 并将 Key 仅传给本机服务和 Electron 主进程。也可以只为当前 PowerShell 会话设置环境变量后运行普通开发版本：

   ```powershell
   $env:DEEPSEEK_API_KEY = '你的本机密钥'
   $env:DEEPSEEK_MODEL = 'deepseek-flash'
   pnpm dev
   ```

2. 在桌面端新建一个内容简短、无文件写入需求的任务；选择执行 AI 为 DeepSeek，并将“执行方式”改为“API 自动执行”。
3. 在“自动协调”区检查队列和费用提示，点击启动，再明确确认一次。只允许这一个任务进入自动队列。
4. 等待任务进入 `review`，核对安全摘要与验收项，再由用户手动验收或退回修改。
5. 未配置 Key、限流、取消或状态未知时，不会自动重试、切换 Provider 或重复收费调用；请按任务卡的恢复提示处理。

## 跨组边界

- A 组管理本机凭据、供应商调用、`dispatch / inspect / cancel` 与脱敏错误。
- B 组管理派发确认、持久化、恢复、人工验收和任务状态。
- 默认任务仍是人工执行；只有用户主动改为 API 自动执行并确认队列后才会产生外部调用。
