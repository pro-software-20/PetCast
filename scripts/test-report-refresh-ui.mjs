import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import {mkdtempSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
if(!process.versions.electron){
 const {default:electron}=await import('electron');const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(electron,[fileURLToPath(import.meta.url)],{env,windowsHide:true,stdio:'inherit'})
 const timer=setTimeout(()=>{child.kill();process.exitCode=1},45000)
 child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1})
}else{
 const {app,BrowserWindow}=await import('electron')
 app.setPath('userData',mkdtempSync(path.join(tmpdir(),'petcast-report-refresh-')))
 void app.whenReady().then(async()=>{
 const w=new BrowserWindow({show:false,width:900,height:650,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}})
 const js=code=>w.webContents.executeJavaScript(code)
 const wait=async code=>{for(let i=0;i<100;i++){if(await js(code))return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out: '+code)}
 try{
  console.log('Window ready'); await w.loadFile(fileURLToPath(new URL('../dist/index.html',import.meta.url)))
  await js(`localStorage.setItem('petcast.usage-source.v1','mock')`)
  await w.reload()
  await wait(`!!document.querySelector('[aria-label="打开报告与建议"]')`)
  await js(`document.querySelector('[aria-label="打开报告与建议"]').click()`)
  await wait(`!!document.querySelector('.history-tabs')`)
  assert.ok(await js(`document.querySelector('.history-tabs').textContent.includes('近期')`))
  await js(`[...document.querySelectorAll('.history-tabs button')].find(b=>b.textContent==='月报').click()`)
  await wait(`!!document.querySelector('.history-scroll')`)
  assert.equal(await js(`document.body.textContent.includes('月报示意')`),false)
  assert.equal(await js(`document.body.textContent.includes('称号随所选区间计算')`),false)
  assert.ok(await js(`parseFloat(getComputedStyle(document.querySelector('.history-scroll')).fontSize)>=15`))
  await wait(`!!document.querySelector('.period-digest') && !!document.querySelector('.token-summary')`)
  await new Promise(r=>setTimeout(r,500))
  await js(`document.querySelector('.history-scroll').scrollTop=200`)
  const before=await js(`document.querySelector('.history-scroll').scrollTop`)
  assert.ok(before>0,'test actually scrolls')
  await js(`window.dispatchEvent(new Event('petcast:task-ledger-changed'))`)
  await new Promise(r=>setTimeout(r,600))
  assert.ok(Math.abs(await js(`document.querySelector('.history-scroll').scrollTop`)-before)<10,'scroll retained after refresh')
  await js(`document.dispatchEvent(new Event('visibilitychange'))`)
  await new Promise(r=>setTimeout(r,600))
  assert.ok(Math.abs(await js(`document.querySelector('.history-scroll').scrollTop`)-before)<10,'scroll retained after visibility change')
  const width=await js(`document.querySelector('.card').getBoundingClientRect().width`)
  w.setSize(1100,800)
  await new Promise(r=>setTimeout(r,300))
  assert.ok(await js(`document.querySelector('.card').getBoundingClientRect().width`)>width,'content follows resizing')
  await js(`document.querySelector('.history-scroll').scrollTop=0`)
  writeFileSync(fileURLToPath(new URL('../report-ui-1115.png',import.meta.url)),(await w.webContents.capturePage()).toPNG())
  console.log('PASS: recent/month labels, no demo entry, readable type, scroll preservation and responsive content')
  app.exit(0)
 }catch(e){console.error(e);app.exit(1)}
 })
}
