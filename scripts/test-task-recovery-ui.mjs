/** Hidden Electron acceptance for B-P3.5.1. All adapters and storage are local fixtures. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const safeRemove = async target => {
  const relative = path.relative(tmpdir(), target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Unsafe fixture cleanup path')
  await rm(target, { recursive: true, force: true })
}

if (!process.versions.electron) {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'petcast-recovery-build-'))
  const { build } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  try {
    await build({ configFile: false, root, base: './', plugins: [react()],
      build: { outDir: fixtureDir, emptyOutDir: true, logLevel: 'error',
        rollupOptions: { input: path.join(root, 'tests', 'task-recovery.html') } } })
    const { default: electron } = await import('electron')
    const logPath = path.join(fixtureDir, 'electron-progress.log')
    const env = { ...process.env, PETCAST_RECOVERY_FIXTURE_HTML: path.join(fixtureDir, 'tests', 'task-recovery.html'), PETCAST_RECOVERY_PROGRESS_LOG: logPath }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, ['--disable-gpu', fileURLToPath(import.meta.url)], {
      cwd: root, env, windowsHide: true, stdio: 'inherit',
    })
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); resolve('timed-out') }, 45_000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1) })
    })
    const progressLog = await readFile(logPath, 'utf8').catch(() => 'Electron did not enter the fixture')
    if (exitCode !== 0 || !progressLog.includes('acceptance-passed')) {
      console.error('Electron progress:', progressLog)
      process.exitCode = typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1
    }
  } finally {
    await safeRemove(fixtureDir)
  }
} else {
  const progress = message => {
    if (process.env.PETCAST_RECOVERY_PROGRESS_LOG) appendFileSync(process.env.PETCAST_RECOVERY_PROGRESS_LOG, `${message}\n`)
  }
  progress('electron-entry')
  const { app, BrowserWindow, session } = await import('electron')
  progress('electron-imported')
  const userData = await mkdtemp(path.join(tmpdir(), 'petcast-recovery-data-'))
  progress('temp-created')
  app.setPath('userData', userData)
  progress('user-data-set')
  void app.whenReady().then(async () => {
  progress('electron-ready')
  const networkRequests = []
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    networkRequests.push(details.url)
    callback({ cancel: true })
  })
  const win = new BrowserWindow({ width: 760, height: 510, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } })
  const html = process.env.PETCAST_RECOVERY_FIXTURE_HTML
  if (!html) throw Error('Missing fixture HTML')
  const js = code => win.webContents.executeJavaScript(code)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function wait(code, label, timeout = 10_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      if (await js(code)) return
      await sleep(40)
    }
    throw Error(`Recovery UI timeout: ${label}`)
  }
  const click = label => js(`(()=>{const name=${JSON.stringify(label)};const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===name);if(!button)throw Error('Missing button: '+name);if(button.disabled)throw Error('Disabled button: '+name);button.click()})()`)
  const cardClick = (index, label) => js(`(()=>{const card=document.querySelectorAll('.task-plan-card')[${index}];if(!card)throw Error('Missing card');const button=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing card button: '+${JSON.stringify(label)});if(button.disabled)throw Error('Disabled card button: '+${JSON.stringify(label)});button.click()})()`)
  async function openCard(index) {
    if (!await js(`document.querySelectorAll('.task-plan-card')[${index}]?.classList.contains('is-expanded')`)) {
      await js(`document.querySelectorAll('.task-plan-card')[${index}].querySelector('.task-plan-card-toggle').click()`)
      await wait(`document.querySelectorAll('.task-plan-card')[${index}]?.classList.contains('is-expanded')`, `card ${index}`)
    }
  }
  async function seed(kind) {
    await js(`window.recoveryFixture.seed(${JSON.stringify(kind)})`)
    await win.reload()
    await wait("document.querySelectorAll('.task-plan-card').length===2", `restore ${kind}`)
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0, 'reload cannot dispatch')
  }
  async function inspect() {
    const label = await js("[...document.querySelectorAll('.task-coordination-actions button')].map(b=>b.textContent.trim()).find(s=>s.includes('检查'))")
    await click(label)
    await wait("document.querySelectorAll('.task-coordination-record').length>0 || !!document.querySelector('.task-plan-error')", 'coordination inspection')
  }
  let fixtureFailed = false
  try {
    progress('loading-fixture')
    await win.loadFile(html)
    progress('fixture-loaded')
    await wait('!!window.recoveryFixture', 'fixture ready')

    console.log('Recovery UI: unknown execution and manual takeover')
    await seed('unknown')
    await inspect()
    await openCard(0)
    assert.equal(await js("document.querySelectorAll('.task-plan-card')[0].textContent.includes('核对外部执行')"), true,
      JSON.stringify({ card: await js("document.querySelectorAll('.task-plan-card')[0].textContent"),
        controls: await js("document.querySelector('.task-coordination-controls')?.textContent"),
        saved: await js('window.recoveryFixture.coordination()') }))
    await cardClick(0, '核对外部执行')
    await wait('window.recoveryFixture.counts().inspect >= 1', 'external status query')
    await cardClick(0, '转人工处理')
    await wait("window.recoveryFixture.session()?.runs[0]?.executionMode==='manual'", 'manual takeover')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)
    assert.equal(await js("JSON.parse(window.recoveryFixture.coordination()).records[0].resolution.action"), 'manual-takeover')
    await wait("document.querySelector('#task-output-task-1')?.disabled===false", 'manual result entry available')
    await js(`(()=>{const area=document.querySelector('#task-output-task-1');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'人工录入的模拟结果。');
      area.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await wait("window.recoveryFixture.session()?.runs[0]?.draft.outputText==='人工录入的模拟结果。'", 'manual result persisted')
    await js('window.recoveryFixture.completePrevious()')
    await win.reload()
    await wait("window.recoveryFixture.session()?.runs[0]?.executionMode==='manual'", 'manual takeover restored')
    await inspect()
    assert.equal(await js("window.recoveryFixture.session()?.runs[0]?.executionMode"), 'manual', 'late result cannot undo takeover')
    assert.equal(await js("window.recoveryFixture.session()?.runs[0]?.draft.outputText"), '人工录入的模拟结果。')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)

    console.log('Recovery UI: uncertain dispatch requires two confirmations and explicit restart')
    await seed('no-receipt')
    await inspect()
    await openCard(0)
    await cardClick(0, '核对后发起新尝试')
    assert.equal(await js("document.querySelectorAll('.task-plan-card')[0].textContent.includes('再次确认：已核对并接受重复调用或计费风险')"), true)
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)
    await cardClick(0, '再次确认：已核对并接受重复调用或计费风险')
    await wait("JSON.parse(window.recoveryFixture.coordination()).records[0].resolution?.action==='new-attempt'", 'saved retry decision')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0, 'decision alone cannot dispatch')
    assert.equal(await js('window.recoveryFixture.session().runs[0].attempt'), 1)
    await win.reload()
    await wait("document.querySelectorAll('.task-plan-card').length===2", 'retry restored')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0, 'reload cannot retry')
    assert.equal(await js("document.querySelector('.task-coordination-controls')?.classList.contains('is-paused')"), true)
    await click('恢复')
    await click('确认并启动')
    await wait('window.recoveryFixture.counts().dispatch === 2', 'explicit dispatch of roots')
    assert.equal(await js("JSON.parse(window.recoveryFixture.coordination()).records.filter(r=>r.taskId==='task-1').length"), 2)
    assert.equal(await js("JSON.parse(window.recoveryFixture.coordination()).records.find(r=>r.taskId==='task-1'&&r.attempt===2).dispatchId !== JSON.parse(window.recoveryFixture.coordination()).records.find(r=>r.taskId==='task-1'&&r.attempt===1).dispatchId"), true)

    console.log('Recovery UI: finished execution is recovered for review')
    await seed('completed')
    await inspect()
    await wait("window.recoveryFixture.session().runs[0].status==='review'", 'completed review')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)

    console.log('Recovery UI: rate limit and persistence failure')
    await seed('rate-limited')
    await inspect()
    await openCard(0)
    assert.equal(await js("document.querySelectorAll('.task-plan-card')[0].textContent.includes('限流')"), true)
    await js('window.recoveryFixture.setFailCoordinationSave(true)')
    await cardClick(0, '核对后发起新尝试')
    await wait("!!document.querySelector('.task-plan-error') || !!document.querySelector('.task-coordination-controls [role=alert]')", 'save failure feedback')
    assert.equal(await js("JSON.parse(window.recoveryFixture.coordination()).records[0].resolution"), undefined)
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)

    console.log('Recovery UI: saved decision survives session save failure')
    await seed('no-receipt')
    await inspect()
    await openCard(0)
    await js('window.recoveryFixture.setFailSessionSave(true)')
    await cardClick(0, '核对后发起新尝试')
    await cardClick(0, '再次确认：已核对并接受重复调用或计费风险')
    await wait("JSON.parse(window.recoveryFixture.coordination()).records[0].resolution?.action==='new-attempt'", 'decision persisted before session failure')
    assert.equal(await js('window.recoveryFixture.session().runs[0].attempt'), 0)
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)
    await js('window.recoveryFixture.setFailSessionSave(false)')
    await win.reload()
    await wait("document.querySelectorAll('.task-plan-card').length===2", 'failed save restored')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)
    await inspect()
    await wait('window.recoveryFixture.session().runs[0].attempt===1', 'session recovered after failed save')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)

    console.log('Recovery UI: corrupt coordination data is preserved')
    await seed('corrupt')
    await inspect()
    assert.equal(await js('window.recoveryFixture.coordination()'), '{broken')
    assert.equal(await js('window.recoveryFixture.counts().dispatch ?? 0'), 0)

    console.log('Recovery UI: active evidence cannot be silently cleared')
    await seed('no-receipt')
    await wait("!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='开始分析' && b.disabled)", 'active evidence locks reanalysis')
    await click('清空输入')
    await click('再次点击确认清空')
    assert.ok(await js('window.recoveryFixture.coordination()'))
    assert.ok(await js('window.recoveryFixture.session()'))
    assert.equal(networkRequests.length, 0, 'no real network request')
    console.log('Desktop task recovery acceptance passed; no network or model calls.')
    progress('acceptance-passed')
  } catch (error) {
    fixtureFailed = true
    progress(`failure: ${error instanceof Error ? error.message : String(error)}`)
    console.error(error)
  } finally {
    win.destroy()
    await safeRemove(userData)
    app.exit(fixtureFailed ? 1 : 0)
  }
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
}
