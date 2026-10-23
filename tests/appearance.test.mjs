import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTs } from './load-ts.mjs'
const prefs = await loadTs('../src/appearance/preferences.ts')
const color = await loadTs('../src/appearance/color.ts')
const registry = await loadTs('../src/appearance/petRegistry.ts')
test('appearance migration validates ids and does not accept arbitrary colors or oversized names',()=>{
 assert.equal(prefs.normalizeAppearance({version:1,petName:'Ruby0\u0000\u001f\u007f'}).petName,'Ruby0')
 const legacy=prefs.normalizeAppearance({version:1,petId:'cat',sceneId:'room'})
 assert.equal(legacy.petId,'cat');assert.equal(legacy.sceneId,'room');assert.equal(legacy.petName,'布罗艾');assert.equal(legacy.shellColor,prefs.ORIGINAL_SHELL_COLOR)
 const invalid=prefs.normalizeAppearance({version:1,petId:'missing',sceneId:'missing',shellColor:'url(javascript:bad)',petName:'\u0000'+ '兔'.repeat(25)})
 assert.equal(invalid.petId,'shark');assert.equal(invalid.sceneId,'river');assert.equal(invalid.shellColor,prefs.ORIGINAL_SHELL_COLOR);assert.equal(Array.from(invalid.petName).length,16)
 assert.deepEqual(prefs.normalizeAppearance({version:55}),prefs.DEFAULT_APPEARANCE)
})
test('appearance preferences use a separate key and save only checked visual settings',()=>{
 const storage=new Map([['petcast.game-save.v1','game untouched'],['other history','history untouched']]);const old=globalThis.window
 globalThis.window={localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}}
 try {const saved=prefs.saveAppearance({...prefs.DEFAULT_APPEARANCE,petId:'rabbit',shellColor:'#a6bcc9'});assert.equal(saved.shellColor,'#A6BCC9');assert.deepEqual(prefs.loadAppearance(),saved);assert.equal(storage.get('petcast.game-save.v1'),'game untouched');assert.equal(storage.get('other history'),'history untouched')}finally{globalThis.window=old}
})
test('shell palette preserves alpha, screen and non-shell colors and never mutates source',()=>{
 const source=new Uint8ClampedArray([248,182,206,255,250,244,232,255,155,156,155,255,48,95,144,255,0,0,0,0,195,29,93,128]);const copy=new Uint8ClampedArray(source)
 const mask=color.prepareShellMask(source);assert.deepEqual(mask.map(p=>p.index),[0,20])
 const result=color.recolorShell(source,mask,'#A6BCC9');assert.deepEqual(source,copy)
 for(let i=0;i<source.length;i+=4){assert.equal(result[i+3],source[i+3]);if(![0,20].includes(i))assert.deepEqual(result.slice(i,i+4),source.slice(i,i+4))}
 assert.notDeepEqual(result.slice(0,3),source.slice(0,3));assert(result[2]>result[0])
})
test('palette conversions round trip chosen colors and all pets have valid idle fallback frames',()=>{
 for(const hex of ['#000000','#FFFFFF','#A6BCC9','#B7C4A4','#F8BDD3','#FF0000'])assert.equal(color.hsvToHex(color.hexToHsv(hex)),hex)
 assert.equal(registry.PETS.length,5)
 for(const pet of registry.PETS){assert(pet.frameWidth>0&&pet.frameHeight>0);assert(pet.animations.idle.frames.length>0);for(const [x,y] of pet.animations.idle.frames){assert(x>=0&&x<pet.columns&&y>=0&&y<pet.rows)}}
 assert.equal(registry.getPet('unknown').id,'shark')
})
