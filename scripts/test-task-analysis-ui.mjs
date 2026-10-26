/** B module end-to-end acceptance. Uses only local fixtures: no OAuth, network, or model call. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))

if (!process.versions.electron) {
  console.log('Task UI: spawning Electron fixture')
  const { default: electron } = await import('electron')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [fileURLToPath(import.meta.url)], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: 'inherit',
  })
  const timer = setTimeout(() => {
    console.error('Task analysis UI acceptance timed out')
    child.kill()
  }, 90_000)
  child.on('exit', code => {
    clearTimeout(timer)
    process.exitCode = code ?? 1
  })
} else {
  console.log('Task UI: Electron fixture booting')
  const { app, BrowserWindow, ipcMain, session } = await import('electron')
  const userData = await mkdtemp(path.join(tmpdir(), 'petcast-task-ui-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'petcast-task-workspace-'))
  await mkdir(path.join(workspaceRoot, 'src'), { recursive: true })
  await mkdir(path.join(workspaceRoot, 'tests'), { recursive: true })
  await mkdir(path.join(workspaceRoot, 'private'), { recursive: true })
  await writeFile(path.join(workspaceRoot, 'src', 'calculator.ts'), 'export const add = (a, b) => a + b\n', 'utf8')
  await writeFile(path.join(workspaceRoot, 'tests', 'calculator.test.ts'), '/* fixture */\n', 'utf8')
  await writeFile(path.join(workspaceRoot, 'private', 'secret.txt'), 'never expose\n', 'utf8')
  app.setPath('userData', userData)

  void app.whenReady().then(async () => {
  console.log('Task UI: Electron ready')

  const scopeId = `codex-${'a'.repeat(64)}`
  const workspaceId = 'b'.repeat(64)
  const now = () => new Date().toISOString()
  const workspace = {
    schemaVersion: 1,
    workspaceId,
    displayName: 'fixture-project',
    entries: [
      { path: 'src', kind: 'directory' },
      { path: 'src/calculator.ts', kind: 'file', size: 35 },
      { path: 'tests', kind: 'directory' },
      { path: 'tests/calculator.test.ts', kind: 'file', size: 14 },
      { path: 'private', kind: 'directory' },
      { path: 'private/secret.txt', kind: 'file', size: 13 },
      { path: 'README.md', kind: 'file', size: 20 },
    ],
    truncated: false,
    warnings: [],
  }

  let currentWindow
  let fixtureMode = 'manual'
  let executionBehavior = 'success'
  let pendingExecutionResolve
  let savedGame = null
  const networkRequests = []
  const prepareRequests = []
  const ledgerEvents = []
  const taskRecords = []
  const cancelledExecutions = []
  let executionCount = 0

  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => {
      networkRequests.push(details.url)
      callback({ cancel: true })
    },
  )

  ipcMain.handle('storage:load', () => savedGame)
  ipcMain.handle('storage:save', (_event, value) => { savedGame = value })
  ipcMain.handle('window:toggle-expanded', (_event, expanded) => {
    currentWindow?.setSize(expanded ? 1008 : 300, expanded ? 526 : 340)
  })
  ipcMain.on('window:drag-start', () => undefined)
  ipcMain.on('window:drag-move', () => undefined)
  ipcMain.on('window:drag-end', () => undefined)
  ipcMain.on('window:close', () => undefined)
  ipcMain.handle('codex:read-usage', () => ({ ok: false, code: 'LOGIN_REQUIRED' }))
  ipcMain.on('codex:cancel-usage', () => undefined)
  ipcMain.handle('chatgpt-auth:read', () => fixtureMode === 'manual'
    ? { ok: false, code: 'REGION_UNSUPPORTED', checkedAt: now() }
    : {
        ok: true,
        status: 'connected',
        sharing: true,
        checkedAt: now(),
        scopeId,
        displayName: 'Fixture Account',
      })
  ipcMain.handle('chatgpt-auth:sign-in', () => ({
    ok: false,
    code: 'REGION_UNSUPPORTED',
    checkedAt: now(),
  }))
  ipcMain.on('chatgpt-auth:cancel', () => undefined)
  ipcMain.handle('chatgpt-auth:sign-out', () => ({
    ok: true,
    status: 'disconnected',
    sharing: false,
    checkedAt: now(),
  }))
  ipcMain.handle('chatgpt-auth:open-usage', () => false)
  ipcMain.handle('codex:check-environment', () => fixtureMode === 'manual'
    ? {
        ok: false,
        code: 'UNAVAILABLE',
        checkedAt: now(),
        minimumVersion: '0.163.0',
      }
    : {
        ok: true,
        checkedAt: now(),
        cliVersion: '0.164.0',
        minimumVersion: '0.163.0',
        scopeId,
        authMode: 'chatgpt-oauth',
      })
  ipcMain.on('codex:cancel-environment', () => undefined)
  ipcMain.handle('prompt:optimize', () => ({ ok: false, code: 'UPSTREAM_UNAVAILABLE' }))
  ipcMain.handle('workspace:select', () => ({ ok: true, workspace }))
  ipcMain.on('workspace:cancel', () => undefined)

  ipcMain.handle('task-execution:prepare', (_event, input) => {
    prepareRequests.push(structuredClone(input))
    return {
      ok: true,
      value: {
        executionId: `execution-${prepareRequests.length}`,
        model: 'fixture-codex',
        preparedFileCount: 2,
        preparedBytes: 49,
        warnings: [],
      },
    }
  })
  const cancelFixtureExecution = id => {
    cancelledExecutions.push(id)
    if (pendingExecutionResolve) {
      pendingExecutionResolve({ ok: false, code: 'CANCELLED', message: '模拟执行已取消。' })
      pendingExecutionResolve = undefined
    }
  }
  ipcMain.handle('task-execution:run', async (event, executionId) => {
    executionCount += 1
    currentWindow?.webContents.send('task-execution:event', {
      executionId,
      stage: 'running',
      message: 'Fixture Codex 正在隔离副本中执行。',
    })
    if (executionBehavior === 'pending') {
      const cancel = () => cancelFixtureExecution(executionId)
      event.sender.once('destroyed', cancel)
      event.sender.once('did-start-navigation', cancel)
      try { return await new Promise(resolve => { pendingExecutionResolve = resolve }) }
      finally {
        event.sender.removeListener('destroyed', cancel)
        event.sender.removeListener('did-start-navigation', cancel)
      }
    }
    currentWindow?.webContents.send('task-execution:event', {
      executionId,
      stage: 'review',
      message: 'Fixture Codex 已完成，等待审核。',
    })
    return {
      ok: true,
      value: {
        artifactId: `artifact-${executionId}`,
        summary: '已实现 divide 并补充测试。',
        outputText: `已完成模拟 Codex 执行。${'详细结果。'.repeat(80)}FULL-RESULT-TAIL`,
        changedFiles: ['src/calculator.ts', 'tests/calculator.test.ts'],
        usage: { inputTokens: 120, outputTokens: 48, cachedInputTokens: 20 },
      },
    }
  })
  ipcMain.on('task-execution:cancel', (_event, id) => {
    cancelFixtureExecution(id)
  })
  ipcMain.handle('task-execution:artifact-read', (_event, artifactId) => ({
    ok: true,
    value: {
      artifactId,
      changedFiles: ['src/calculator.ts', 'tests/calculator.test.ts'],
      diff: '--- a/src/calculator.ts\n+++ b/src/calculator.ts\n+export const divide = (a, b) => a / b\n',
      safetyStatus: 'safe',
    },
  }))
  ipcMain.handle('task-execution:artifact-apply', () => ({ ok: true, value: null }))
  ipcMain.handle('task-execution:artifact-discard', () => ({ ok: true, value: null }))

  ipcMain.handle('tasks:execution-write', (_event, value) => {
    ledgerEvents.push(structuredClone(value))
    return { ok: true }
  })
  ipcMain.handle('tasks:executions', () => ({ ok: true, data: [] }))
  ipcMain.handle('tasks:reconcile', () => ({ ok: true }))
  ipcMain.handle('tasks:append', (_event, values) => {
    taskRecords.push(...structuredClone(values))
    return { ok: true }
  })
  ipcMain.handle('tasks:query', () => ({ ok: true, data: [] }))
  ipcMain.handle('tasks:clear', () => ({ ok: true }))
  ipcMain.handle('tasks:evaluate', () => ({ ok: true }))
  ipcMain.handle('tasks:evaluations', () => ({ ok: true, data: [] }))
  ipcMain.handle('history:append', () => ({ ok: true }))
  ipcMain.handle('history:query', () => ({ ok: true, data: [] }))
  ipcMain.handle('history:clear', () => ({ ok: true }))

  const index = path.join(root, 'dist', 'index.html')
  const preload = path.join(root, 'dist-electron', 'preload.cjs')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  const createWindow = async ({ clearStorage = false } = {}) => {
    const previousWindow = currentWindow && !currentWindow.isDestroyed() ? currentWindow : undefined
    const win = new BrowserWindow({
      width: 1008,
      height: 526,
      frame: false,
      show: false,
      webPreferences: {
        preload,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true,
      },
    })
    currentWindow = win
    await win.loadFile(index)
    previousWindow?.destroy()
    if (clearStorage) {
      await win.webContents.executeJavaScript('localStorage.clear()')
      await win.reload()
    }
    await win.webContents.executeJavaScript(`Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => { window.__petcastCopied = String(value) } },
    })`)
    return win
  }

  const js = code => currentWindow.webContents.executeJavaScript(code)
  async function wait(code, label, timeout = 8_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await js(code)) return
      await sleep(40)
    }
    throw new Error(`Task UI timeout: ${label}`)
  }
  const click = label => js(`(()=>{
    const expected=${JSON.stringify(label)};
    const button=[...document.querySelectorAll('button')].find(candidate =>
      candidate.textContent.trim()===expected || candidate.getAttribute('aria-label')===expected
      || candidate.getAttribute('aria-label')==='打开'+expected);
    if(!button) throw Error('missing button: '+expected);
    button.click();
  })()`)
  const setValue = (selector, value) => js(`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!element) throw Error('missing input: '+${JSON.stringify(selector)});
    const prototype=element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true}));
  })()`)
  const openCard = async index => {
    const expanded = await js(`document.querySelectorAll('.task-plan-card')[${index}]?.classList.contains('is-expanded')`)
    if (expanded) return
    await js(`document.querySelectorAll('.task-plan-card')[${index}]?.querySelector('.task-plan-card-toggle')?.click()`)
    await wait(`document.querySelectorAll('.task-plan-card')[${index}]?.classList.contains('is-expanded')`, `task ${index + 1} expanded`)
  }
  const clickInCard = async (index, label) => {
    await openCard(index)
    return js(`(()=>{
    const card=document.querySelectorAll('.task-plan-card')[${index}];
    if(!card) throw Error('missing task card '+${index});
    const button=[...card.querySelectorAll('button')].find(candidate=>candidate.textContent.trim()===${JSON.stringify(label)});
    if(!button) throw Error('missing task button: '+${JSON.stringify(label)});
    button.click();
  })()`)
  }
  const openTaskAnalysis = async () => {
    await wait("!!document.querySelector('main')", 'application shell')
    if (await js("!!document.querySelector('.shell-home')")) {
      await click('主页')
      await wait("!!document.querySelector('.wood-nav')", 'expanded navigation')
    }
    await click('任务分析')
    await wait("!!document.querySelector('.task-analysis-panel')", 'task analysis panel')
  }
  const analyze = async prompt => {
    console.log(`Task UI: analyze ${prompt.slice(0, 24)}`)
    await setValue('#task-analysis-prompt', prompt)
    await click('开始分析')
    await wait("!!document.querySelector('.task-analysis-result') && !!document.querySelector('.task-plan-panel')", 'analysis and plan')
  }
  const addAnalysisFiles = () => js(`(()=>{
    const input=document.querySelector('#task-analysis-files');
    const transfer=new DataTransfer();
    transfer.items.add(new File(['fixture'], 'requirements.pdf', {type:'application/pdf'}));
    transfer.items.add(new File(['export {}'], 'example.ts', {type:'text/typescript'}));
    input.files=transfer.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`)
  const completeManualCard = async index => {
    await openCard(index)
    const status = await js(`document.querySelectorAll('.task-plan-card')[${index}].className`)
    if (status.includes('is-ready')) {
      await clickInCard(index, '复制任务 Prompt')
      assert.ok(await js(`document.querySelectorAll('.task-plan-card')[${index}].classList.contains('is-ready')`))
      await clickInCard(index, '已交给 AI，开始跟踪')
      await wait(`document.querySelectorAll('.task-plan-card')[${index}].classList.contains('is-running')`, `task ${index + 1} running`)
    }
    const longResult = `任务 ${index + 1} 的人工结果摘要。${'详细过程。'.repeat(90)}FULL-RESULT-TAIL-${index}`
    await setValue(`#task-output-${index + 1}`, longResult).catch(async () => {
      await js(`(()=>{
        const card=document.querySelectorAll('.task-plan-card')[${index}];
        const area=card.querySelector('.task-result-editor textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(longResult)});
        area.dispatchEvent(new Event('input',{bubbles:true}));
      })()`)
    })
    await js(`(()=>{
      const card=document.querySelectorAll('.task-plan-card')[${index}];
      for(const select of card.querySelectorAll('.task-result-editor fieldset select')){
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'passed');
        select.dispatchEvent(new Event('change',{bubbles:true}));
      }
    })()`)
    await clickInCard(index, '提交待验收')
    await wait(`document.querySelectorAll('.task-plan-card')[${index}].classList.contains('is-review')`, `task ${index + 1} review`)
    await clickInCard(index, '验收通过')
    await wait(`document.querySelectorAll('.task-plan-card')[${index}].classList.contains('is-done')`, `task ${index + 1} done`)
    const hasActionable = await js(`[...document.querySelectorAll('.task-plan-card')].some(card=>!card.classList.contains('is-done')&&(card.classList.contains('is-ready')||card.classList.contains('is-running')||card.classList.contains('is-needs-input')||card.classList.contains('is-review')))`)
    if (hasActionable) {
      assert.equal(await js("!!document.querySelector('.task-plan-card.is-expanded:not(.is-done)')"), true)
    }
  }
  const completeAllManualTasks = async () => {
    for (let guard = 0; guard < 20; guard += 1) {
      const statuses = await js(`[...document.querySelectorAll('.task-plan-card')].map(card=>card.className)`)
      if (statuses.every(value => value.includes('is-done'))) return
      const index = statuses.findIndex(value => value.includes('is-ready') || value.includes('is-running'))
      if (index < 0) throw new Error(`No completable task: ${statuses.join(', ')}`)
      await completeManualCard(index)
    }
    throw new Error('Manual task completion exceeded guard limit')
  }
  const passFinalAcceptance = async () => {
    await js(`(()=>{
      for(const input of document.querySelectorAll('.task-final-check input:not(:checked):not(:disabled)')) input.click();
    })()`)
    await wait("!!document.querySelector('.task-report-actions')", 'final report')
  }
  const configureWorkspace = async () => {
    await click('选择项目文件夹')
    await wait("document.querySelector('.task-workspace-selector')?.textContent.includes('fixture-project')", 'workspace selected')
    await click('设置默认范围')
    await wait("!!document.querySelector('.workspace-scope-dialog')", 'workspace scope dialog')
    await js(`document.querySelector('.workspace-scope-dialog label[title="src"] input').click()`)
    await click('可修改范围（0）')
    await js(`document.querySelector('.workspace-scope-dialog label[title="src"] input').click()`)
    await click('高级设置')
    await click('禁止范围（0）')
    await js(`document.querySelector('.workspace-scope-dialog label[title="private"] input').click()`)
    await click('输出位置（0）')
    await setValue('.workspace-manual-output input', 'src/generated.ts')
    await click('添加新输出')
    await click('保存文件授权')
    await wait("!document.querySelector('.workspace-scope-dialog')", 'workspace scope saved')
  }

  async function manualFallbackScenario() {
    console.log('Task UI: manual fallback scenario')
    fixtureMode = 'manual'
    await createWindow({ clearStorage: true })
    await openTaskAnalysis()
    assert.equal(await js("document.querySelectorAll('.codex-setup-status').length"), 1)
    assert.equal(await js("document.querySelector('.codex-setup-status').open"), false)
    assert.equal(await js("document.querySelectorAll('.codex-setup-status .chatgpt-auth-status').length"), 1)
    assert.equal(await js("document.querySelectorAll('.codex-setup-status .codex-environment-status').length"), 1)
    await wait("document.querySelector('.chatgpt-auth-status')?.textContent.includes('当前地区无法连接 ChatGPT')", 'regional fallback')
    assert.match(await js("document.querySelector('.chatgpt-auth-status').textContent"), /复制任务 Prompt/)
    await click('开始分析')
    await wait("document.querySelector('.task-analysis-error')?.textContent.includes('EMPTY_INPUT')", 'empty input error')

    await analyze('请总结这段需求并给出建议。')
    await setValue('#task-analysis-prompt', '新的输入会清除旧结果。')
    assert.equal(await js("!!document.querySelector('.task-analysis-result')"), false)
    await addAnalysisFiles()
    const mixedPrompt = [
      '请分别完成以下任务：',
      '1. 分析产品需求并给出技术方案。',
      '2. 使用 TypeScript 实现核心功能。',
      '3. 独立撰写中文使用说明。',
      '4. 完成任务 2 后运行测试并汇总结果。',
    ].join('\n')
    await analyze(mixedPrompt)
    console.log('Task UI: mixed plan created')
    assert.equal(await js("document.querySelectorAll('.task-plan-card').length"), 4)
    assert.equal(await js("!!document.querySelector('.task-analysis-overview')"), true)
    assert.equal(await js("document.querySelector('#task-analysis-details').hidden"), true)
    assert.equal(await js("document.querySelectorAll('.task-plan-card.is-expanded').length"), 1)
    await openCard(1)
    assert.equal(await js("document.querySelectorAll('.task-plan-card.is-expanded').length"), 1)
    assert.equal(await js("document.querySelectorAll('.task-plan-card')[0].classList.contains('is-expanded')"), false)
    await js("document.querySelectorAll('.task-plan-card')[1].querySelector('.task-plan-settings > summary').click()")
    assert.equal(await js("document.querySelectorAll('.task-plan-card')[1].querySelector('.task-plan-settings').open"), true)
    await js("document.querySelectorAll('.task-plan-card')[1].querySelector('.task-plan-prompt > summary').click()")
    assert.equal(await js("document.querySelectorAll('.task-plan-card')[1].querySelector('.task-plan-prompt').open"), true)
    const planText = await js("document.querySelector('.task-plan-panel').textContent")
    assert.match(planText, /AI：DeepSeek/)
    assert.match(planText, /AI：Codex/)
    assert.match(planText, /AI：豆包/)
    assert.ok(await js("document.querySelectorAll('.task-plan-card.is-ready').length >= 2"))
    assert.ok(await js("document.querySelectorAll('.task-plan-card.is-waiting').length >= 1"))

    const firstReady = await js(`[...document.querySelectorAll('.task-plan-card')].findIndex(card=>card.classList.contains('is-ready'))`)
    await clickInCard(firstReady, '复制任务 Prompt')
    await wait(`document.querySelectorAll('.task-plan-card')[${firstReady}]?.textContent.includes('任务仍未开始')`, 'copy does not start task')
    assert.ok(await js(`document.querySelectorAll('.task-plan-card')[${firstReady}].classList.contains('is-ready')`))
    assert.equal(await js(`document.querySelectorAll('.task-plan-card')[${firstReady}].querySelector('.task-dependency-editor').disabled`), false)

    const secondReady = await js(`[...document.querySelectorAll('.task-plan-card')].findIndex((card,index)=>index!==${firstReady}&&card.classList.contains('is-ready'))`)
    assert.ok(secondReady >= 0)
    await js(`Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('fixture copy failure') } },
    }); window.__petcastOriginalExecCommand = document.execCommand.bind(document);
    document.execCommand = () => false; true`)
    await clickInCard(secondReady, '复制任务 Prompt')
    await wait(`document.querySelectorAll('.task-plan-card')[${secondReady}]?.textContent.includes('任务状态未改变')`, 'copy failure does not start task')
    assert.ok(await js(`document.querySelectorAll('.task-plan-card')[${secondReady}].classList.contains('is-ready')`))
    await js(`Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => { window.__petcastCopied = String(value) } },
    }); document.execCommand = window.__petcastOriginalExecCommand; true`)

    await clickInCard(firstReady, '已交给 AI，开始跟踪')
    await wait(`document.querySelectorAll('.task-plan-card')[${firstReady}].classList.contains('is-running')`, 'manual task started')
    await sleep(450)
    await currentWindow.reload()
    await currentWindow.webContents.executeJavaScript(`Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async value => { window.__petcastCopied = String(value) } },
    })`)
    await openTaskAnalysis()
    await wait("document.querySelectorAll('.task-plan-card').length === 4", 'unfinished session restored')
    assert.ok(await js("document.querySelectorAll('.task-plan-card.is-running').length === 1"))
    assert.ok(await js("document.querySelector('.task-plan-card.is-running').classList.contains('is-expanded')"))
    await completeAllManualTasks()
    console.log('Task UI: manual tasks completed')
    await passFinalAcceptance()
    await click('复制报告')
    await wait("document.querySelector('.task-report-actions')?.textContent.includes('报告已复制')", 'report copied')
    const report = await js('window.__petcastCopied')
    assert.match(report, /最终验收/)
    assert.doesNotMatch(report, /FULL-RESULT-TAIL/)

    await currentWindow.reload()
    await openTaskAnalysis()
    await wait("document.querySelector('.task-session-restore')?.textContent.includes('发现最近已完成的任务报告')", 'completed session restored')
    await click('查看上次报告')
    await wait("!!document.querySelector('.task-report-actions')", 'restored report visible')
  }

  async function automaticExecutionScenario() {
    console.log('Task UI: simulated automatic execution scenario')
    fixtureMode = 'automatic'
    executionBehavior = 'success'
    await createWindow({ clearStorage: true })
    await openTaskAnalysis()
    await wait("document.querySelector('.chatgpt-auth-status')?.textContent.includes('ChatGPT 已连接')", 'fixture auth connected')
    await wait("document.querySelector('.codex-environment-status')?.textContent.includes('Codex 已就绪')", 'fixture Codex ready')
    await analyze('1. 使用 TypeScript 实现 src/calculator.ts 的 divide 函数并运行测试。')
    assert.equal(await js("document.querySelectorAll('.task-plan-card').length"), 3)
    await configureWorkspace()
    console.log('Task UI: workspace configured')
    await completeManualCard(0)
    await wait("[...document.querySelectorAll('.task-plan-card button')].some(button=>button.textContent.trim()==='使用 Codex 执行'&&!button.disabled)", 'Codex execution enabled')
    const automaticIndex = await js(`[...document.querySelectorAll('.task-plan-card')].findIndex(card=>[...card.querySelectorAll('button')].some(button=>button.textContent.trim()==='使用 Codex 执行'&&!button.disabled))`)
    assert.ok(automaticIndex >= 0)
    await clickInCard(automaticIndex, '使用 Codex 执行')
    await wait("!!document.querySelector('[aria-label=\"确认 Codex 自动执行\"]')", 'execution confirmation')
    await click('确认并开始')
    await wait("!!document.querySelector('.task-codex-artifact')", 'artifact review')
    console.log('Task UI: simulated artifact ready')
    assert.equal(await js(`([...document.querySelectorAll('.task-plan-card')[${automaticIndex}].querySelectorAll('button')]).some(button=>button.textContent.trim()==='验收通过')`), false)
    assert.match(await js("document.querySelector('.task-codex-artifact').textContent"), /待处理文件改动/)
    await clickInCard(automaticIndex, '应用改动')
    await wait(`document.querySelectorAll('.task-plan-card')[${automaticIndex}]?.textContent.includes('文件改动已安全应用')`, 'artifact applied')
    await js(`(()=>{
      const card=document.querySelectorAll('.task-plan-card')[${automaticIndex}];
      for(const select of card.querySelectorAll('.task-result-editor fieldset select')){
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'passed');
        select.dispatchEvent(new Event('change',{bubbles:true}));
      }
    })()`)
    await clickInCard(automaticIndex, '验收通过')
    await wait(`document.querySelectorAll('.task-plan-card')[${automaticIndex}]?.classList.contains('is-done')`, 'automatic task accepted')
    await completeAllManualTasks()
    await passFinalAcceptance()

    assert.equal(executionCount, 1)
    assert.ok(ledgerEvents.some(event => event.kind === 'start'))
    assert.ok(ledgerEvents.some(event => event.kind === 'complete'))
    assert.ok(taskRecords.some(record => record.calls?.[0]?.usage?.basis === 'provider-reported'))
    const prepared = prepareRequests.at(-1)
    assert.equal(prepared.workspaceId, workspaceId)
    assert.deepEqual(prepared.scope.readPaths, ['src'])
    assert.deepEqual(prepared.scope.allowedWritePaths, ['src'])
    assert.deepEqual(prepared.scope.forbiddenPaths, ['private'])
    assert.deepEqual(prepared.scope.outputPaths, ['src/generated.ts'])
    assert.doesNotMatch(JSON.stringify(prepared), /petcast-task-workspace|secret\.txt|never expose/i)
  }

  async function interruptedAndCorruptRecoveryScenario() {
    console.log('Task UI: interrupted and corrupt recovery scenario')
    fixtureMode = 'automatic'
    executionBehavior = 'pending'
    await createWindow({ clearStorage: true })
    await openTaskAnalysis()
    await analyze('1. 使用 TypeScript 修复 src/calculator.ts 并运行测试。')
    await configureWorkspace()
    await completeManualCard(0)
    const automaticIndex = await js(`[...document.querySelectorAll('.task-plan-card')].findIndex(card=>[...card.querySelectorAll('button')].some(button=>button.textContent.trim()==='使用 Codex 执行'&&!button.disabled))`)
    assert.ok(automaticIndex >= 0)
    await clickInCard(automaticIndex, '使用 Codex 执行')
    await wait("!!document.querySelector('[aria-label=\"确认 Codex 自动执行\"]')", 'pending execution confirmation')
    await click('确认并开始')
    await wait(`document.querySelectorAll('.task-plan-card')[${automaticIndex}]?.classList.contains('is-running')`, 'automatic execution running')
    await sleep(450)
    const callsBeforeReload = executionCount
    await currentWindow.reload()
    await openTaskAnalysis()
    await wait("document.querySelector('.task-plan-card.is-needs-input') !== null", 'interrupted execution recovery')
    console.log('Task UI: interrupted execution recovered')
    assert.equal(executionCount, callsBeforeReload)
    assert.match(await js("document.querySelector('.task-plan-card.is-needs-input').textContent"), /信息已补充，继续/)

    await js("localStorage.setItem('petcast.task-session.v1', '{broken')")
    await currentWindow.reload()
    await openTaskAnalysis()
    await wait("document.querySelector('.task-storage-notice')?.textContent.includes('CORRUPT_DATA')", 'corrupt session warning')
    assert.equal(await js("localStorage.getItem('petcast.task-session.v1')"), '{broken')
    await click('清除本地记录')
    await wait("!document.querySelector('.task-storage-notice')", 'corrupt session cleared explicitly')
  }

  try {
    await manualFallbackScenario()
    await automaticExecutionScenario()
    await interruptedAndCorruptRecoveryScenario()
    assert.deepEqual(networkRequests, [], `Unexpected network requests: ${networkRequests.join(', ')}`)
    assert.ok(cancelledExecutions.length > 0, 'Interrupted execution should be cancelled during reload')
    console.log('Task analysis UI acceptance passed: manual fallback, mixed planning, persistence, simulated Codex execution, artifacts, acceptance, report, interruption and corrupt-session recovery; zero network/model calls')
    app.exit(0)
  } catch (error) {
    console.error(error)
    if (currentWindow && !currentWindow.isDestroyed()) {
      console.error(await currentWindow.webContents.executeJavaScript("document.body.innerText.slice(0,5000)").catch(() => ''))
    }
    app.exit(1)
  }
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
}
