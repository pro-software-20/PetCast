import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const prefs = await loadTs('../src/appearance/preferences.ts')
const { SHELLS, getShell, getShellSize } = await loadTs('../src/appearance/shellRegistry.ts')
const { getLocalDayCycle } = await loadTs('../src/appearance/dayCycle.ts')

test('older appearance saves retain pet, name and palette while migrating to the cat shell', () => {
  const migrated = prefs.normalizeAppearance({ version:1, petId:'dog', sceneId:'room', petName:'我的小狗', shellColor:'#a6bcc9' })
  assert.equal(migrated.shellId,'cat'); assert.equal(migrated.petId,'dog'); assert.equal(migrated.petName,'我的小狗'); assert.equal(migrated.shellColor,'#A6BCC9')
  assert.equal(prefs.normalizeAppearance({ version:1, shellId:'../../other.png' }).shellId,'cat')
})
test('all four shell shapes are validated and stored independently of animal and color', () => {
  const data = new Map(), previous = globalThis.window
  globalThis.window = { localStorage:{ getItem:key=>data.get(key)??null, setItem:(key,value)=>data.set(key,value) } }
  try {
    for (const shell of SHELLS) {
      prefs.saveAppearance({...prefs.DEFAULT_APPEARANCE, shellId:shell.id, shellColor:'#B7C4A4', petId:'rabbit'})
      const restored=prefs.loadAppearance()
      assert.equal(restored.shellId,shell.id); assert.equal(restored.shellColor,'#B7C4A4'); assert.equal(restored.petId,'rabbit')
    }
  } finally { globalThis.window = previous }
})
test('each complete shell and square screen fit the unchanged compact window and three physical controls', () => {
  assert.deepEqual(SHELLS.map(s=>s.id),['cat','dog','rabbit','round'])
  for (const shell of SHELLS) {
    const size=getShellSize(shell), screen=shell.screen
    assert(size.width<=272.443 && size.height<=310.001)
    const preview=getShellSize(shell,73,100)
    assert(preview.width<=73.001 && preview.height<=100.001)
    assert(Math.abs(preview.width/preview.height-shell.width/shell.height)<1e-8)
    const side=size.width*screen.size/100
    assert(screen.left>=0 && screen.top>=0 && screen.left+screen.size<=100)
    assert(size.height*screen.top/100+side<size.height)
    assert.equal(shell.buttons.length,3)
    for (const button of shell.buttons) {
      assert(button.left>0 && button.left<100 && button.top>0 && button.top<100)
      assert(size.height*button.top/100+size.width*button.size/200<=size.height)
    }
  }
  assert.equal(getShell('missing').id,'cat')
})
test('local daytime periods change at exactly the user-confirmed boundaries', () => {
  const at=(hour,minute=0)=>getLocalDayCycle(new Date(2026,9,23,hour,minute))
  assert.deepEqual(at(5,59),{period:'night',label:'黑夜'})
  assert.deepEqual(at(6),{period:'day',label:'白天'})
  assert.deepEqual(at(16,59),{period:'day',label:'白天'})
  assert.deepEqual(at(17),{period:'evening',label:'傍晚'})
  assert.deepEqual(at(18,59),{period:'evening',label:'傍晚'})
  assert.deepEqual(at(19),{period:'night',label:'黑夜'})
  assert.equal(at(23,59).period,'night'); assert.equal(at(0).period,'night')
})
