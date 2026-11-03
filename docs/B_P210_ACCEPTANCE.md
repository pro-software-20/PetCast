# P2.10 Render 公网部署与团队验收

## 交付目标

P2.10 将 PetCast AI 服务部署为 Render 新加坡区域的免费演示 Web Service。免费实例不挂载持久磁盘，匿名限流文件会在实例重启、重新部署或平台回收后丢失，因此仅适合课程展示和短期团队试用。团队 Windows 测试包只内置非敏感 HTTPS 服务源地址，不包含 DeepSeek Key、后端代码或本地环境文件。

本阶段仍属于匿名限流的团队测试版，不适合作为商业公开服务。DeepSeek、Render 或网络异常时，任务分析页继续回退本地规则大脑。

## Render 创建步骤

1. 登录 Render，并确认已连接 `pro-software-20/PetCast` GitHub 仓库。
2. 在 Render Dashboard 选择 **New → Blueprint**，导入仓库根目录的 `render.yaml`。
3. 确认服务名为 `petcast-ai-pro-software-20-beta`、区域为 Singapore、规格为 `free`、实例数为 1。
4. 在首次 Blueprint 配置中填写 `DEEPSEEK_API_KEY`。不要把 Key 写入 Git、聊天记录、安装包或普通环境说明。
5. 确认没有付费持久磁盘，健康检查路径为 `/health`。
6. 等待部署完成，记录 Render 实际分配的 `https://*.onrender.com` 地址。
7. 在 DeepSeek 控制台设置消费上限，并在 Render 配置账单提醒。

免费实例的 `/data/rate-limits.json` 位于临时文件系统。服务在当前运行周期内仍会执行匿名限流，但重启后计数会重置。正式公开服务必须升级为付费实例并恢复持久化存储，或者改用共享数据库限流。

如果 Render 账号尚未连接 GitHub，先完成 GitHub 授权再创建 Blueprint。Secret 只在首次创建时填写；后续 Blueprint 同步不会覆盖 `sync: false` 的 Secret。

## 公网服务验收

先执行零推理检查：

```powershell
$env:PETCAST_PUBLIC_AI_API_URL="https://Render实际域名"
pnpm test:public-ai
```

确认健康检查和安全拒绝通过后，只执行一次真实规划：

```powershell
$env:PETCAST_RUN_PUBLIC_AI_TESTS="1"
pnpm test:public-ai
Remove-Item Env:PETCAST_RUN_PUBLIC_AI_TESTS
```

脱敏报告写入被 Git 忽略的 `work/public-ai-acceptance.json`。报告不得包含 API Key、完整 Prompt、任务正文或 DeepSeek 原始响应。

## 团队安装包

公网验收通过后构建 `0.1.3-beta.1`：

```powershell
$env:PETCAST_PUBLIC_AI_API_URL="https://Render实际域名"
pnpm dist:win:public
```

检查：

- `dist-electron/ai-service-config.json` 只含 HTTPS origin；
- 成品不含 `.env.local`、`DEEPSEEK_API_KEY`、`dist-server`、诊断报告或用户数据；
- `release/windows/SHA256SUMS.txt` 与安装包一致；
- GitHub 使用 `v0.1.3-beta.1` Draft Release，异机验收前不公开发布。

## 异机验收记录

| 项目 | 结果 |
| --- | --- |
| Render 服务地址 | 待部署后填写 |
| 部署提交 | 待部署后填写 |
| `/health` | 待验收 |
| 公网真实规划 | 待验收 |
| 安装包 SHA-256 | 待构建后填写 |
| 测试电脑与 Windows 版本 | 待异机验收 |
| DeepSeek 规划成功 | 待异机验收 |
| 断网回退本地规则 | 待异机验收 |
| 会话恢复不重复调用 | 待异机验收 |
| 其他模块回归 | 待异机验收 |

## 回滚与故障处理

- 新部署健康检查失败时，在 Render Deploys 页面回滚到上一个成功部署。
- DeepSeek 费用异常时先暂停 Render 服务或移除 Key，并在 DeepSeek 控制台停用对应 Key。
- 免费实例可能休眠、冷启动较慢，并会在重启或重新部署后丢失限流计数；测试期间不作为稳定生产服务。
- 客户端无法访问服务时不自动重试收费规划，继续使用本地规则大脑。
