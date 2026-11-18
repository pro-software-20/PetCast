# Codex 统一文本执行队列（本地）

基线 main 7082bd6，尚未上传仓库。该入口与 DeepSeek 共用 B 的启动确认、依赖调度、暂停、取消、恢复和待验收流程。

## 使用

输入任务时先选择“任务拆解大脑”：本地规则、DeepSeek 或 Codex。选择 Codex 后，点击“连接并允许使用本机 Codex”，先核对本机登录、账户与本机执行服务，不调用模型。再点击“开始分析”，让 Codex 拆解目标、安排依赖并推荐执行 AI。未连接时明确使用本地规则；连接后服务失败也会记录实际回退来源，不转发给团队账户。

方案生成后，在“这组任务怎么执行”点击“将适合的任务统一设为 Codex 自动执行”，再检查队列并确认启动。拆解前建立的连接可以直接复用。使用本机 Codex 账户，无需 DeepSeek API Key，也不使用任务页原 OAuth 连接。DeepSeek 需输入用户自己的 API Key；缺少时不再静默调用团队规划服务。

当前统一队列仅接入文本结果。原项目文件读写仍使用既有隔离执行与 diff 确认流程，不通过统一文本队列静默修改。主控 AI 的执行者推荐在能力匹配时保留；不匹配时使用本地能力校验结果。任务完成后仍需验收，不应演示为完全无人监督。

## 实现与限制

- 主进程每次执行建立应用专用临时目录，复用现有 Codex app-server 隔离执行；不向队列提供用户工作区。
- 连接优先记录 accountScopeId，缺少时使用 scopeId；执行前仍重新核对账号，禁止跳过不一致检查。
- 显式连接仅本次应用运行有效。重启后队列默认暂停，先核对旧执行，不自动重复派发。
- 与 DeepSeek 共享持久化传输结构，但使用独立文件 codex-queue.v1.json、独立本机 runner，结果平台始终为 codex。不会发到 DeepSeek API。
- 配置、派发、查询和取消均检查可信主窗口及 preload IPC；结果不自动视为验收通过。
- 2026-11-18 已定位并修复本机连接兼容问题：默认 WebSocket 请求出现连接失败、responseStreamDisconnected 和超时；同一账户、同一模型改用 HTTP 流式连接后返回真实结果。队列与 Codex 大脑共用独立的 petcast_openai_http Provider 配置，仅作用于 PetCast 启动的子进程，不修改用户 config.toml，不切换模型，不添加 API Key，也不覆盖内置 openai Provider。认证和默认服务地址由 Codex 自身处理。
- 真实桌面 IPC 验收已通过：连接、生成两个任务的方案、派发其中一个纯文本子任务、观察 running → completed、取回 255 字符正文及真实 usage（该子任务输入 15226、输出 182 Token）。脱敏证据见 work/codex-desktop-live.json。模型调用包含 Codex 自带上下文，输入 Token 不等于用户输入的字数。
- 以上证明当前机器上的文本拆解及一个子任务执行通过，不代表所有机器或任意软件操作均已验收，也不代表两项任务已自动完成最终验收。连接按钮仍只检查本机服务；开始分析或启动任务才产生推理调用。
- 新增规划与执行进度：启动、核对账户、等待模型、生成、连接重试、完成、失败、停止；只显示固定脱敏消息，不输出上游原始错误。等待阶段显示经过秒数。所有 RPC 有 30 秒等待上限，规划生成最多 120 秒，文本执行最多 300 秒。
- 修复最终结果提取：使用 agentMessage 的最终正文，不将过程说明混入 JSON 任务方案。支持停止规划；已取消的迟到响应不会创建任务。
- 单元测试覆盖幂等派发、平台身份、拒绝未授权文件范围；桌面 fixture 覆盖显式连接、批量切换 local-agent、确认后派发与结果进入待验收。

真实验收脚本 scripts/check-codex-queue-live.mjs 默认关闭；仅显式设置 PETCAST_RUN_CODEX_QUEUE_LIVE=1 才发送一个固定短文本请求。再次运行前应确认上一测试已经结束。

scripts/check-codex-desktop-live.mjs 使用同一显式开关，通过真实 preload/IPC 做拆解和一个子任务执行，使用临时应用数据；不会读取用户项目。scripts/diagnose-codex-connection.mjs 默认仅做元数据诊断，--live 才发送短请求，--http 使用修复后的兼容连接。真实测试会消耗账户额度，不能当作每次启动时的隐式检测。

验证：生产构建通过；533 项契约测试通过；兼容连接、认证保留、取消和最终正文提取测试通过；真实桌面 IPC 联调通过。

接口依据：https://learn.chatgpt.com/docs/config-file/config-reference （model_providers.<id>.supports_websockets / requires_openai_auth）。
