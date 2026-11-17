# A 组：DeepSeek API ExecutionAdapter

## 交付结论

A 组提供第一个真实统一执行适配器：

- Provider ID：`deepseek`
- 执行模式：`api`
- 能力：文本分析、研究、写作、审查和不要求本机文件修改的代码建议
- 统一方法：`dispatch()`、`inspect()`、`cancel()`
- 生产调用位置：Electron 主进程；API Key 不进入 renderer、B 协调状态或执行结果

## 幂等与恢复

主进程在调用 DeepSeek 前，先原子保存 `dispatchId`、完整请求副本、适配器执行 ID 和 queued 快照。

- 相同 `dispatchId` 和相同请求返回原 receipt，不产生第二次供应商调用；
- 相同 `dispatchId` 搭配不同请求返回 `INVALID_INPUT`；
- `inspect()` 只读取原执行记录，绝不重新调用 DeepSeek；
- 已完成、失败或取消的记录在应用重启后仍可查询；
- 应用退出或崩溃时无法确认的在途请求变为 `unknown`，交给 B 人工核对，禁止自动重派；
- `cancel()` 只取消指定执行且可重复调用。

记录保存在 Electron `userData/deepseek-executions.v1.json`，最多保留最近 500 条。文件只包含任务执行材料和安全结果，不包含 API Key、Authorization Header、供应商原始响应或本机绝对路径。

## 配置

开发环境通过服务端/主进程环境变量提供：

```powershell
$env:DEEPSEEK_API_KEY = '<仅设置在本机，不提交>'
$env:DEEPSEEK_MODEL = 'deepseek-flash'
pnpm dev
```

缺少 API Key 时适配器返回安全的 `UNAVAILABLE`，不会跨越供应商边界。

## 错误映射

| 场景 | 统一错误码 |
| --- | --- |
| 请求或幂等冲突 | `INVALID_INPUT` |
| 缺少/无效 API 配置、5xx | `UNAVAILABLE` |
| HTTP 429 | `RATE_LIMITED` |
| 执行超时 | `TIMEOUT` |
| 用户取消 | `CANCELLED` |
| 未知引用或重启后的不确定在途请求 | `EXECUTION_NOT_FOUND` |
| 返回格式或大小无效 | `INVALID_RESPONSE` |
| 其他供应商失败 | `FAILED` |

返回给 B 的错误消息是固定安全文案，不复制响应正文、stderr、凭据、账号信息或绝对路径。

## 零网络验证

```powershell
pnpm test:adapter-conformance
pnpm test:contracts
pnpm typecheck
```

`deepSeekExecutionFixture.ts` 提供可注入客户端，覆盖完成、等待输入、失败、限流、取消、重复派发、恢复查询、未知执行、预取消和错误脱敏。专用测试额外断言：重复 `dispatchId` 的底层 Provider 启动次数严格为 1。

## 跨组边界

- A 提供适配器、真实客户端、持久化、错误映射、fixture 和注册工厂；
- B 在 P3.8A 中调用 `createAExecutionAdapterRegistry()` 注入协调器，并继续独占任务状态决策；
- A 不修改 `TaskSessionV1`，也不将任务直接标记为完成；
- D 只接收 B 过滤后的摘要、验证结果与证据，不接收完整供应商输出。

第一版不会修改本机文件，`changedFiles` 始终为空；验收项返回 `not-run`，由 B/D 或用户完成复核。Codex `local-agent` 统一化留到后续阶段。
