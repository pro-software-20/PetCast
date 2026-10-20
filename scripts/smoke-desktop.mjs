import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const live = process.argv.includes('--codex')
const env = { ...process.env, PETCAST_SMOKE_TEST: '1', PETCAST_SMOKE_CODEX: live ? '1' : '0' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const timer = setTimeout(() => { child.kill(); console.error('Desktop smoke test timed out'); process.exitCode = 1 }, 25_000)
child.stdout.on('data', chunk => { output = (output + chunk.toString()).slice(-16_384) })
child.stderr.on('data', () => {})
child.on('error', () => { clearTimeout(timer); console.error('Electron could not start'); process.exitCode = 1 })
child.on('exit', code => {
  clearTimeout(timer)
  const markers = ['PETCAST_RENDERER_READY', 'PETCAST_PRELOAD_READY']
  if (live) markers.push('PETCAST_CODEX_IPC_READY')
  const passed = code === 0 && markers.every(marker => output.includes(marker))
  console.log(passed ? `Desktop smoke passed${live ? ' (real Codex IPC)' : ''}` : 'Desktop smoke failed')
  if (!passed) process.exitCode = 1
})
