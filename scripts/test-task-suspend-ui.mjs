import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
if (!process.versions.electron) {
  const { default: electron } = await import('electron')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electron, [fileURLToPath(import.meta.url)], { env, windowsHide: true, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill(), 45000)
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'petcast-suspend-')))
  void app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } })
    const js = code => w.webContents.executeJavaScript(code)
    const wait = async code => { for (let i=0;i<150;i++) { if(await js(code)) return; await new Promise(r=>setTimeout(r,50)) } throw Error('Timeout: '+code) }
    const click = async label => js(`[...document.querySelectorAll('button')].find(b=>!b.disabled && b.textContent.trim()===${JSON.stringify(label)}).click()`)
    try {
      await w.loadFile(fileURLToPath(new URL('../dist/index.html', import.meta.url)))
      await wait(`!!document.querySelector('[aria-label="打开任务分析"]')`)
      await js(`document.querySelector('[aria-label="打开任务分析"]').click()`)
      await wait(`!!document.querySelector('#task-analysis-prompt')`)
      await js(`(()=>{const el=document.querySelector('#task-analysis-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'请撰写校园读书活动宣传文案');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
      await click('开始分析')
      await wait(`!!document.querySelector('.task-plan-panel')`)
      const savedBefore = await js(`JSON.parse(localStorage.getItem('petcast.task-session.v1'))`)
      await click('结束当前任务')
      await click('暂存并退出')
      await wait(`!!localStorage.getItem('petcast.suspended-session.v1')`)
      await w.reload()
      await wait(`!!document.querySelector('[aria-label="打开任务分析"]')`)
      await js(`document.querySelector('[aria-label="打开任务分析"]').click()`)
      await wait(`!!document.querySelector('[aria-label="暂存的任务"]')`)
      assert.equal(await js(`JSON.parse(localStorage.getItem('petcast.task-session.v1')).id`), savedBefore.id)
      assert.equal(await js(`document.querySelector('.task-plan-panel').checkVisibility()`), false)
      await click('继续任务')
      await wait(`!document.querySelector('[aria-label="暂存的任务"]')`)
      assert.equal(await js(`document.querySelector('.task-plan-panel').checkVisibility()`), true)
      await click('结束当前任务')
      await click('不暂存，结束任务')
      await wait(`!localStorage.getItem('petcast.task-session.v1')`)
      await new Promise(r=>setTimeout(r,600))
      assert.equal(await js(`localStorage.getItem('petcast.task-session.v1')`), null, 'autosave must not resurrect discarded task')
      console.log('PASS: end dialog, save, reload, resume same task, discard without autosave resurrection')
      app.exit(0)
    } catch (error) { console.error(error); app.exit(1) }
  })
}
