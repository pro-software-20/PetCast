/** Opt-in real desktop IPC acceptance. Uses temporary app data and a synthetic text task. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
if(process.env.PETCAST_RUN_CODEX_QUEUE_LIVE!=='1') throw Error('Explicit live check flag required')
const root=fileURLToPath(new URL('..',import.meta.url))
if(!process.versions.electron){
  const {default:electron}=await import('electron')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const child=spawn(electron,[fileURLToPath(import.meta.url)],{cwd:root,env,windowsHide:true,stdio:'inherit'})
  const timer=setTimeout(()=>{console.error('Desktop live check exceeded time limit');child.kill()},330000)
  child.on('exit',code=>{clearTimeout(timer);process.exitCode=code??1})
}else{
  const {app,BrowserWindow}=await import('electron')
  const scratch=await mkdtemp(path.join(tmpdir(),'petcast-codex-desktop-live-'))
  app.setPath('userData',scratch)
  console.log('Live desktop fixture starting')
  void app.whenReady().then(async () => {
  const {registerCodexQueueIpc}=await import('../dist-electron/codexQueueIpc.js')
  const {createCodexScopeIdentity}=await import('../dist-electron/codexScopeIdentity.js')
  const page=path.join(scratch,'check.html');await writeFile(page,'<!doctype html><title>Isolated PetCast acceptance</title>')
  const rendererUrl=pathToFileURL(page).href
  const window=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'dist-electron/preload.cjs'),contextIsolation:true,nodeIntegration:false}})
  const queue=registerCodexQueueIpc({getWindow:()=>window,rendererUrl,userData:scratch,identity:createCodexScopeIdentity(scratch)})
  let reference,exitCode=0
  const deadline=setTimeout(async()=>{console.log('Live desktop check timed out');await queue.dispose();app.exit(1)},300000)
  const js=code=>window.webContents.executeJavaScript(code)
  const report={timestamp:new Date().toISOString(),transport:'http',connected:false,planning:false,execution:false}
  try{
    await window.loadURL(rendererUrl)
    const connected=await js('window.petcast.connectCodexQueue()')
    assert.equal(connected.configured,true,connected.message);report.connected=true;console.log('Real desktop connection passed')
    const prompt='为校园读书会安排两个纯文本任务：先写三步活动流程，再根据流程写80字招募文案。不检索、不操作文件。'
    const request={requestId:'live-plan',input:{prompt,files:[],providers:[{id:'codex',displayName:'Codex',capabilities:['planning','text-generation'],executionModes:['manual','local-agent']}],analysis:{taskType:'writing',complexity:'low',estimatedInputTokens:{min:10,max:100},estimatedOutputTokens:{min:100,max:1000},estimationBasis:'heuristic-metadata',assumptions:[],optimizedPrompt:prompt,promptOptimizationSource:'local',canRunInParallel:false,parallelPlan:[],warnings:[]}}}
    const plan=await js(`window.petcast.planTaskWithCodex(${JSON.stringify(request)})`)
    assert.equal(plan.ok,true,plan.code);assert.equal(plan.provider,'codex');assert.ok(plan.plan.tasks.length>0)
    report.planning=true;report.taskCount=plan.plan.tasks.length;console.log(JSON.stringify({realPlanning:true,taskCount:report.taskCount}))
    const task=plan.plan.tasks.find(task=>task.dependsOn.length===0);assert.ok(task)
    const receipt=await js(`window.petcast.dispatchCodexQueue(${JSON.stringify({dispatchId:'live-execution',taskId:task.id,title:task.title,description:task.description,prompt:task.prompt,dependencySummaries:[],acceptanceChecks:task.acceptanceChecks})})`)
    assert.equal(receipt.ok,true,receipt.error?.code)
    reference={dispatchId:receipt.value.dispatchId,adapterExecutionId:receipt.value.adapterExecutionId,taskId:receipt.value.taskId}
    let previous
    for(let count=0;count<130;count++){
      const inspected=await js(`window.petcast.inspectCodexQueue(${JSON.stringify(reference)})`)
      assert.equal(inspected.ok,true,inspected.error?.code)
      const snapshot=inspected.value
      if(snapshot.state!==previous){console.log('Real task state: '+snapshot.state);previous=snapshot.state}
      if(snapshot.state==='completed'){
        assert.ok(snapshot.result.outputText.trim());report.execution=true;report.outputCharacters=snapshot.result.outputText.length;report.usage=snapshot.result.usage;break
      }
      if(['failed','cancelled','unknown'].includes(snapshot.state))throw Error('Execution: '+snapshot.error?.code)
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
    assert.equal(report.execution,true,'No completed result')
    console.log(JSON.stringify(report))
  }catch(error){exitCode=1;report.error=String(error.message).slice(0,200);console.log(JSON.stringify(report))}
  finally{
    if(reference&&!report.execution)await js(`window.petcast.cancelCodexQueue(${JSON.stringify(reference)})`).catch(()=>{})
    await queue.dispose();window.destroy();clearTimeout(deadline)
    await writeFile(path.join(root,'work','codex-desktop-live.json'),JSON.stringify(report,null,2))
    const resolved=path.resolve(scratch)
    if(path.dirname(resolved)===path.resolve(tmpdir())&&path.basename(resolved).startsWith('petcast-codex-desktop-live-'))await rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:200}).catch(()=>{})
    app.exit(exitCode)
  }
  }).catch(error=>{console.error(String(error.message).slice(0,200));app.exit(1)})
}
