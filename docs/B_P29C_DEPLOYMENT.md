# P2.9C：DeepSeek 任务规划服务部署

本服务同时提供：

- `POST /v1/prompt/optimize`
- `POST /v1/task/plan`
- `GET /health`

客户端只发送 Prompt、分析结果、附件元信息及执行 Provider 的公开能力。附件内容、工作区路径、账号、额度和 API Key 不会发送到服务。

## Docker 构建与运行

```bash
docker build -t petcast-ai:latest .
docker run --rm -p 8787:8787 \
  -e DEEPSEEK_API_KEY="..." \
  -e RATE_LIMIT_HASH_SECRET="至少 32 个随机字符" \
  -v petcast-ai-data:/data \
  petcast-ai:latest
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

运行镜像只包含编译后的 `dist-server`，使用非 root 用户，并把限流状态写入 `/data/rate-limits.json`。密钥必须通过部署平台的运行时 Secret 注入，禁止写入镜像、仓库或客户端安装包。

## 公网部署要求

腾讯云、Render 或其他支持 Docker 的平台均可使用同一镜像。正式环境必须满足：

1. 对外只开放 HTTPS；容器的 8787 端口保持在内网。
2. 当前文件限流器按单实例设计；部署一个实例并持久化挂载 `/data`。
3. 在 DeepSeek 控制台设置消费上限，并同时保留服务端匿名限流。
4. 只有反向代理会可靠覆盖来源 IP 时才设置 `PETCAST_TRUST_PROXY=1`；否则保持 `0`，避免伪造转发头绕过限流。
5. 配置平台健康检查路径 `/health`，并允许容器接收 `SIGTERM` 完成优雅关闭。

反向代理示例（域名和证书路径需替换）：

```nginx
server {
  listen 443 ssl http2;
  server_name ai.example.com;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 30s;
  }
}
```

## Windows 公开安装包

内部测试包仍可执行：

```powershell
pnpm dist:win
```

公开安装包必须显式提供 HTTPS 服务源地址：

```powershell
$env:PETCAST_PUBLIC_AI_API_URL="https://ai.example.com"
pnpm dist:win:public
```

构建脚本会在安装包的 `dist-electron/ai-service-config.json` 中写入非敏感服务源地址。缺失地址或使用 HTTP 时，公开打包会直接失败。开发环境仍可使用 `PETCAST_AI_API_URL=http://127.0.0.1:8787`；正式安装包不会读取运行时环境变量覆盖内置地址。

## 真实 DeepSeek 联调

先执行不产生规划推理的上游诊断：

```powershell
pnpm diagnose:deepseek
```

诊断通过 `GET https://api.deepseek.com/models` 区分未配置 Key、认证失败、余额不足、限流、上游异常、超时、无效响应和模型不可用。报告写入 `work/deepseek-upstream-diagnostic.json`，只包含脱敏分类、HTTP 状态、模型和耗时，不包含 Key、响应正文、Prompt 或账号信息。

真实联调默认关闭，并且一次运行最多发起一次规划调用：

```powershell
$env:PETCAST_RUN_LIVE_AI_TESTS="1"
npm run test:task-planning:live
```

Key 从被 Git 忽略的 `.env.local` 或当前进程环境读取。脚本会先运行 `/models` 预检；预检失败时写入脱敏报告并以失败状态退出，不发送推理请求。预检成功后只发送一次混合任务规划请求，不自动重试。报告写入 `work/deepseek-planning-live-report.json`，只记录模型、耗时、任务/依赖数量、Provider 分布和校验结果，不记录完整 Prompt、任务正文、上游响应正文或 Key。

当前仓库环境未安装 Docker，因此使用 `npm run test:server-package` 验证编译服务、健康检查、限流恢复、优雅停止和 Dockerfile 静态安全属性。发布前还需要在已安装 Docker 的机器或云端构建环境执行一次实际 `docker build`。

2026-11-02 的首次真实联调按当时上限执行了两次请求，两次均安全返回 `UPSTREAM_UNAVAILABLE`，未进行自动重试。P2.9C.1 增加上游诊断后，`/models` 预检取得 `READY`，确认当前 Key、网络和 `deepseek-flash` 模型可用；随后唯一一次规划调用被上游以 HTTP 402 拒绝，安全分类为 `INSUFFICIENT_BALANCE`，没有自动重试。账号余额恢复后仍需重新执行一次成功路径验收；成功报告生成前，不应把模拟测试、预检通过或安全回退视为真实 DeepSeek 规划验收通过。
