/** Fixture-based renderer acceptance. No user credentials or network required. Build first. */
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
const root = fileURLToPath(new URL('..', import.meta.url))
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [fileURLToPath(import.meta.url)], {cwd: root, env, windowsHide: true, stdio: 'inherit'})
  const timer = setTimeout(() => child.kill(), 45000)
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const { registerUsageHistoryIpc } = await import('../dist-electron/historyIpc.js')
  const { createCodexDiagnostics } = await import('../dist-electron/codexDiagnostics.js')
  app.setPath('userData', await mkdtemp(path.join(tmpdir(), 'petcast-ui-')))
  void app.whenReady().then(async () => {
  const scopeId = `codex-${'a'.repeat(64)}`
  const now = new Date()
  const usage = { shortWindowRemaining: 37, weeklyRemaining: 61, sampledAt: now.toISOString(),
    shortWindowResetAt: new Date(+now + 3600000).toISOString(), weeklyResetAt: new Date(+now + 4 * 86400000).toISOString() }
  const windowFixture = (usedPercent, windowDurationMins) => ({ usedPercent, windowDurationMins, resetsAt: Math.floor(+now/1000) + 3600 })
  usage.diagnostics = createCodexDiagnostics({account:{email:'fixture@example.invalid',planType:'plus'}}, {
    rateLimitsByLimitId:{codex:{primary:windowFixture(63,300),secondary:windowFixture(39,10080)},
      codex_other:{primary:windowFixture(5,300),secondary:windowFixture(1,10080)}},
  }, 'path', true)
  const mockUsage = {...usage, shortWindowRemaining: 88, weeklyRemaining: 77, burnRate: 5, baselineBurnRate: 5}
  const initialSave = {version: 1, usage: mockUsage, aquarium: [], codex: {}, mailItems: [], unreadMailIds: [], autoFishingEnabled: false, resetWatchEnabled: false}
  let saved = initialSave, mode = 'login', resolvePending
  ipcMain.handle('storage:load', () => saved)
  ipcMain.handle('storage:save', (_e, value) => { saved = value })
  ipcMain.handle('codex:read-usage', async () => {
    if (mode === 'pending') return new Promise(resolve => { resolvePending = resolve })
    if (mode === 'login') return {ok: false, code: 'LOGIN_REQUIRED'}
    if (mode === 'stale') return {ok: false, code: 'UNAVAILABLE', scopeId}
    return {ok: true, snapshot: {...usage, scopeId, sampledAt: new Date().toISOString()}}
  })
  const win = new BrowserWindow({width: 300, height: 340, frame: false, show: false, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  }})
  registerUsageHistoryIpc(() => win, app.getPath('userData'), pathToFileURL(path.join(root, 'dist/index.html')).href)
  ipcMain.handle('window:toggle-expanded', (_e, expanded) => win.setSize(expanded ? 1008 : 300, expanded ? 526 : 340))
  const js = code => win.webContents.executeJavaScript(code)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function wait(code, label) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) { if (await js(code)) return; await sleep(40) }
    throw new Error(`UI timeout: ${label}`)
  }
  const click = label => js(`(()=>{const all=${JSON.stringify(label)}==='真实额度'||${JSON.stringify(label)}==='模拟演示'?document.querySelectorAll('.source-options button'):document.querySelectorAll('button');const b=[...all].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')==='打开'+${JSON.stringify(label)}); if(!b)throw Error('missing button'); b.click()})()`)
  const openQuota = async () => { if (await js(`!!document.querySelector('.shell-home')`)) { await click('主页'); await wait(`!!document.querySelector('.wood-nav')`, 'expanded navigation') }; await js(`[...document.querySelectorAll('.wood-nav button')].find(b=>b.textContent==='真实额度').click()`); await wait(`!!document.querySelector('.quota-page')`, 'quota page') }
  const status = (source, value) => `document.querySelector('main')?.dataset.usageSource === '${source}' && document.querySelector('main')?.dataset.usageStatus === '${value}'`
  async function shot(name) {
    if (!process.env.PETCAST_UI_SCREENSHOTS) return
    await win.webContents.capturePage()
    await sleep(150)
    await mkdir(process.env.PETCAST_UI_SCREENSHOTS, {recursive: true})
    await writeFile(path.join(process.env.PETCAST_UI_SCREENSHOTS, `${name}.png`), (await win.webContents.capturePage()).toPNG())
  }
  try {
    await win.loadFile(path.join(root, 'dist/index.html'))
    await wait(status('real','unavailable'), 'cold login failure')
    assert.equal(await js(`(document.querySelector('.usage-board')??document.querySelector('.device-quotas')).textContent.includes('88%')`), false)
    assert.equal(await js(`document.querySelector('.device-quotas').textContent.includes('—')`), true)
    assert.ok(Math.abs(win.getSize()[0]-300)<=1 && Math.abs(win.getSize()[1]-340)<=1, "Windows DPI rounding must remain within one pixel")
    const screen = await js(`(()=>{const r=document.querySelector('.device-screen').getBoundingClientRect();return [r.width,r.height]})()`);assert.ok(Math.abs(screen[0]-screen[1])<.1)
    await openQuota()
    assert.equal(await js(`(()=>{const b=document.querySelector('[aria-label="关闭真实额度"]');const r=b.getBoundingClientRect();return r.width>=28&&r.height>=28&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b})()`), true, 'quota close button is visible and clickable')
    await js(`document.querySelector('[aria-label="关闭真实额度"]').click()`)
    await wait(`document.querySelector('main').dataset.page==='home'&&!document.querySelector('.quota-page')`, 'quota close returns home')
    assert.equal(await js(`document.querySelector('.wood-nav button[aria-current="page"]').textContent`), '主页')
    await openQuota()
    assert.match(await js(`document.querySelector('.usage-read-feedback').textContent`), /登录/)
    await shot('01-login-required')
    mode = 'pending'; await click('重新读取')
    await wait(`document.querySelector('.usage-refresh').disabled`, 'loading feedback')
    await shot('02-loading')
    resolvePending({ok:true, snapshot:{...usage,scopeId}})
    await wait(status('real','fresh'), 'real quota')
    assert.equal(await js(`document.querySelector('.usage-settings-values').textContent.includes('37%')`), true)
    assert.match(await js(`document.querySelector('.usage-settings-values').textContent`), /数据不足/)
    await js(`document.querySelector('.usage-source-details').open = true`)
    const details = await js(`document.querySelector('.usage-source-details').textContent`)
    assert.match(details, /f\*\*\*@e\*\*\*/)
    assert.match(details, /codex_other/)
    assert.match(details, /已用 5% \/ 剩余 95%/)
    assert.match(details, /已用 1% \/ 剩余 99%/)
    assert.doesNotMatch(details, /fixture@example/)
    await shot('03-source-verification')
    await js(`document.querySelector('.usage-source-details').open = false`)
    await click('形象'); await wait(`!!document.querySelector('.appearance-page')`, 'appearance page')
    assert.deepEqual(await js(`[...document.querySelectorAll('.wood-nav button')].map(b=>b.textContent)`), ['主页','形象','任务分析','真实额度'])
    for (const label of ['猫','狗','鸡','兔子','鲨鱼']) { await js(`document.querySelector('[aria-label="选择${label}"]').click()`); await wait(`document.querySelector('.pet-choice-row button[aria-pressed="true"]')?.textContent.includes('${label}')`, 'pet selection') }
    assert.equal(await js(`document.querySelector('.shell-choice h2').textContent.trim()`), '外观颜色')
    assert.equal(await js(`document.querySelectorAll('.shell-choice-grid button').length`), 4)
    for (const name of ['猫耳','垂耳狗','长耳兔','圆形']) {
      await js(`document.querySelector('[aria-label="切换${name}外壳"]').click()`)
      await wait(`document.querySelector('.shell-choice-grid button[aria-pressed="true"]')?.textContent.includes('${name}')`, 'shell selection')
    }
    const sprite = await js(`document.querySelector('.appearance-preview-pet img').src`)
    await js(`document.querySelector('[aria-label="外壳雾蓝"]').click()`); await click('✓ 保存设置')
    assert.equal(await js(`JSON.parse(localStorage.getItem('petcast.appearance.v1')).shellColor`), '#A6BCC9')
    assert.equal(await js(`document.querySelector('.appearance-preview-pet img').src`), sprite)
    await click('收起'); await wait(`!!document.querySelector('.compact-device')`, 'compact restored')
    assert.equal(await js(`document.querySelector('.compact-device').dataset.shellId`), 'round')
    const changedScreen = await js(`(()=>{const r=document.querySelector('.device-screen').getBoundingClientRect();return [r.width,r.height]})()`);assert.ok(Math.abs(changedScreen[0]-changedScreen[1])<.1)
    await shot('03-compact-real')
    await click('主页'); await sleep(350)
    assert.equal(await js(`!!document.querySelector('.mock-controls')`), false)
    await click('开启自动钓鱼')
    await sleep(350)
    const beforeStale = saved.mailItems.length
    mode = 'stale'; await click('重新读取')
    await wait(status('real','stale'), 'stale snapshot')
    assert.equal(await js(`document.querySelector('.fishing-spot').disabled`), true)
    assert.match(await js(`document.querySelector('.usage-read-feedback').textContent`), /采样：/)
    assert.equal(await js(`!!document.querySelector('.reset-tide')`), false)
    assert.equal(await js(`!!document.querySelector('.pet-bubble')`), false)
    await sleep(350)
    assert.equal(saved.mailItems.length, beforeStale)
    assert.equal(saved.usage.shortWindowRemaining, 88, 'real quotas must not overwrite mock save')
    await shot('04-expanded-stale')
    // Model returning to a visible window / network recovery without waiting for the poll interval.
    await js(`void Object.defineProperty(document, 'visibilityState', {configurable:true, get:()=> 'visible'})`)
    mode = 'live'; await js(`window.dispatchEvent(new Event('online'))`)
    await wait(status('real','fresh'), 'network recovery refresh')
    mode = 'stale'; await js(`window.dispatchEvent(new Event('focus'))`)
    await wait(status('real','stale'), 'focus triggers a fresh read')
    await js(`delete document.visibilityState`)
    await click('模拟演示'); await wait(status('mock','fresh'), 'mock switch')
    assert.equal(await js(`!!document.querySelector('.mock-controls')`), true)
    assert.equal(await js(`document.querySelector('.usage-board').textContent.includes('88%')`), true)
    await shot('05-expanded-mock')
    await win.reload(); await wait(status('mock','fresh'), 'source preference survives restart')
    assert.equal(await js(`document.querySelector('.compact-device').dataset.shellId`), 'round')
    await openQuota(); mode = 'pending'; await click('真实额度')
    await wait(status('real','loading'), 'source switch clears mock immediately')
    assert.equal(await js(`(document.querySelector('.usage-board')??document.querySelector('.device-quotas')).textContent.includes('88%')`), false)
    await click('模拟演示'); await wait(status('mock','fresh'), 'cancel pending real')
    resolvePending({ok:true,snapshot:{...usage,scopeId}}); await sleep(150)
    assert.equal(await js(status('mock','fresh')), true)
    mode = 'live'; await click('真实额度'); await wait(status('real','fresh'), 'real recovers')
    mode = 'login'; await click('重新读取'); await wait(status('real','unavailable'), 'logout clears old account quota')
    assert.equal(await js(`document.querySelector('.usage-board').textContent.includes('37%')`), false)
    await js("localStorage.removeItem('petcast.usage-source.v1')")
    const browserWin = new BrowserWindow({width: 1024, height: 600, show: false, webPreferences: {contextIsolation: true, nodeIntegration: false}})
    await browserWin.loadFile(path.join(root, 'dist/index.html'))
    const browserJs = code => browserWin.webContents.executeJavaScript(code)
    for (let i = 0; i < 100; i++) {
      if (await browserJs(status('real', 'unavailable'))) break
      await sleep(40)
    }
    assert.equal(await browserJs(status('real', 'unavailable')), true)
    await browserJs("document.querySelector('.shell-home').click()"); await browserJs("[...document.querySelectorAll('.wood-nav button')].find(b=>b.textContent==='真实额度').click()")
    assert.match(await browserJs("document.querySelector('.usage-read-feedback').textContent"), /浏览器无法读取本机/)
    await browserJs("[...document.querySelectorAll('button')].find(b=>b.textContent==='模拟演示').click()")
    for (let i = 0; i < 100; i++) {
      if (await browserJs(status('mock', 'fresh'))) break
      await sleep(40)
    }
    assert.equal(await browserJs(status('mock', 'fresh')), true)
    browserWin.destroy()
    console.log('Usage/appearance UI acceptance passed: 300x340 compact; square display; five pets; four shells; shell palette; navigation; source diagnostics; browser fallback; loading, login, real, stale, mock, persistence, cancellation, logout, focus/online refresh')
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
  }).catch(error => { console.error(error); app.exit(1) })
}
