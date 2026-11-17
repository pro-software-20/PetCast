import { spawn } from 'node:child_process'
import process from 'node:process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

/**
 * The release gate is deliberately local-only. It must never start dev:ai,
 * run a live DeepSeek check, or read a local API key.
 */
export const RELEASE_READINESS_STEPS = Object.freeze([
  { id: 'contracts', command: npmCommand, args: ['run', 'test:contracts'] },
  { id: 'typecheck', command: npmCommand, args: ['run', 'typecheck'] },
  { id: 'adapter-conformance', command: npmCommand, args: ['run', 'test:adapter-conformance'] },
  { id: 'evaluation-conformance', command: npmCommand, args: ['run', 'test:evaluation-conformance'] },
  { id: 'coordination-e2e', command: npmCommand, args: ['run', 'test:coordination-e2e'] },
  { id: 'coordination-d-e2e', command: npmCommand, args: ['run', 'test:coordination-d-e2e'] },
  { id: 'desktop-deepseek-d-e2e', command: npmCommand, args: ['run', 'test:desktop-deepseek-d-e2e'] },
  { id: 'build', command: npmCommand, args: ['run', 'build'] },
  { id: 'task-ui', command: npmCommand, args: ['run', 'test:task-ui'] },
  { id: 'task-recovery-ui', command: npmCommand, args: ['run', 'test:task-recovery-ui'] },
  { id: 'desktop-smoke', command: npmCommand, args: ['run', 'test:desktop'] },
  { id: 'diff-check', command: 'git', args: ['diff', '--check'] },
])

const quoteWindowsArgument = value => (/^[A-Za-z0-9:._/-]+$/.test(value)
  ? value
  : `"${value.replaceAll('"', '""')}"`)

const run = (step, cwd = process.cwd()) => new Promise((resolve, reject) => {
  // Windows cannot directly execute an npm.cmd shim with spawn(shell: false).
  // Run the fixed internal command list through cmd.exe instead of using
  // spawn(shell: true), which emits a warning and can weaken argument safety.
  const windows = process.platform === 'win32'
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : step.command
  const args = windows
    ? ['/d', '/s', '/c', [step.command, ...step.args].map(quoteWindowsArgument).join(' ')]
    : step.args
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  })
  child.once('error', error => reject(new Error(`${step.id} could not start: ${error.message}`)))
  child.once('exit', code => {
    if (code === 0) resolve()
    else reject(new Error(`${step.id} failed with exit code ${code ?? 'unknown'}.`))
  })
})

export async function verifyReleaseReadiness({ cwd = process.cwd(), steps = RELEASE_READINESS_STEPS } = {}) {
  for (const step of steps) {
    console.log(`\n[release-readiness] ${step.id}`)
    await run(step, cwd)
  }
  console.log('\nRelease readiness gate passed. No live provider call was run.')
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) {
  verifyReleaseReadiness().catch(error => {
    console.error(`\nRelease readiness gate stopped: ${error.message}`)
    process.exitCode = 1
  })
}
