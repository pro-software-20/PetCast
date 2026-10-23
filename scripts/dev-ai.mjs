import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'

const apiKey = process.env.DEEPSEEK_API_KEY?.trim()

if (!apiKey) {
  console.error([
    '未找到 DEEPSEEK_API_KEY。',
    '请打开项目根目录的 .env.local，填写：',
    'DEEPSEEK_API_KEY=你的真实Key',
    '不要把 .env.local 提交到 Git。',
  ].join('\n'))
  process.exit(1)
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(npmCommand, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(signal ? `进程被 ${signal} 终止` : `命令执行失败，退出码：${code}`))
  })
})

try {
  await run(['run', 'build:electron'])
  await run(['run', 'build:server'])

  const environment = {
    ...process.env,
    DEEPSEEK_API_KEY: apiKey,
    RATE_LIMIT_HASH_SECRET: process.env.RATE_LIMIT_HASH_SECRET?.trim()
      || randomBytes(32).toString('hex'),
    HOST: '127.0.0.1',
    PORT: '8787',
    PROMPT_RATE_LIMIT_STATE_PATH: process.env.PROMPT_RATE_LIMIT_STATE_PATH?.trim()
      || path.resolve('work', 'prompt-rate-limits.local.json'),
    PETCAST_TRUST_PROXY: '0',
    PETCAST_PROMPT_API_URL: 'http://127.0.0.1:8787',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173',
  }

  console.log('正在启动 PetCast 本地 AI 版本；API Key 仅传给本机 Prompt 服务。')
  await run(['run', 'dev:ai:processes'], { env: environment })
} catch (error) {
  console.error(error instanceof Error ? error.message : '本地 AI 版本启动失败')
  process.exitCode = 1
}
