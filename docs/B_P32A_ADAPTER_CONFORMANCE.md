# B-P3.2A 执行适配器合规测试与跨组接入规范

## 目的

P3.2A 为 A 组交付的 `ExecutionAdapter` 提供统一、零网络、可重复的合规测试。B 组只负责调度、幂等键、恢复与状态决策；A 组负责真实 AI、登录、凭据、软件或 API 调用和供应商错误映射。

默认发行版仍使用空适配器注册表。运行本套件不会连接真实 AI，也不会产生费用。

## 快速运行

```powershell
pnpm test:adapter-conformance
```

标准样例由 `createInMemoryExecutionAdapterConformanceFixture()` 提供，覆盖完成、等待输入、失败、限流和取消场景。

## A 组交付要求

A 组至少为一个真实 Provider 提供：

1. 实现 `dispatch()`、`inspect()`、`cancel()` 的 `ExecutionAdapter`；
2. 使用 `dispatchId` 作为真实幂等键，重复派发不得产生第二次收费调用；
3. `inspect()` 只查询已有执行，不能用重新执行代替恢复；
4. 使用可注入的供应商客户端或电脑操作驱动，合规测试必须注入零网络 fixture；
5. fixture 为每个场景创建独立适配器实例，并断言底层供应商调用次数；
6. 将供应商错误映射为 `ExecutionAdapterError`，不得返回 stderr、响应正文、凭据或绝对路径；
7. 提交 Provider ID、执行模式、注册代码和专用合规测试命令。

示例：

```ts
const fixture: ExecutionAdapterConformanceFixture = {
  providerId: 'custom:example',
  executionMode: 'api',
  createAdapter: scenario => new ExampleAdapter(createFakeClient(scenario)),
  createRequest: () => createValidDispatchRequest(),
}

const report = await runExecutionAdapterConformance(fixture)
```

合规运行器检查收据关联、重复派发、冲突幂等键、仅查询恢复、未知引用、取消、预取消、结果关联、状态映射、错误脱敏和输入不可变。它使用有限轮询与超时，不会永久等待。

## 数据边界

允许传递：任务定义、直接依赖交接摘要、验证结果和安全相对路径元信息。

禁止传递：API Key、登录凭据、额度快照、绝对路径、完整供应商响应、完整前置任务输出和任意电脑操作命令。

合规报告只包含固定检查 ID、布尔结果和安全摘要，绝不复制适配器错误正文。

## 跨组边界

- **A 组**：实现并注册真实执行适配器，负责供应商连接、幂等和恢复查询。
- **B 组**：运行合规套件、注册适配器、执行调度与任务状态决策，不管理供应商凭据。
- **C 组**：只在 `local-agent` 适配器需要电脑操作时向 A 组提供受限能力，不直接接收 B 派发。
- **D 组**：P3.2A 无需改动；P3.2B 可提供与 `dispatchId`、`taskId` 匹配的评价 fixture，正式接入在 P3.3。

## 恢复原则

应用重启后必须通过已有 `ExecutionReference` 调用 `inspect()`。未知执行、损坏记录或无收据的中断派发一律进入人工核对，不得自动重新派发、切换 Provider 或重复收费。
