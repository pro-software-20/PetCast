import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadTs } from './load-ts.mjs'

const roaming = await loadTs('../src/appearance/petRoaming.ts')
const registry = await loadTs('../src/appearance/petRegistry.ts')
const seeded = seed => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }

test('pet activity uses separate bounded sand and water habitats', () => {
  for (const id of ['cat','dog','chicken','rabbit']) assert.equal(roaming.getPetHabitat(id).kind, 'sand')
  assert.equal(roaming.getPetHabitat('shark').kind, 'water')
  assert.equal(roaming.getPetHabitat('unknown').kind, 'water')
})
test('five-minute roaming stays in bounds, rests without drifting, and turns at least 18 seconds apart', () => {
  for (const id of ['cat','shark','rabbit']) {
    const random = seeded(2341), phases = new Set(), faces = new Set()
    let state = roaming.createPetRoaming(id, random), lastTurn = 0, turns = 0
    for (let ms = 0; ms < 300_000; ms += 50) {
      const before = state
      state = roaming.advancePetRoaming(state, 50, random)
      assert(state.x >= state.habitat.minX && state.x <= state.habitat.maxX)
      if (before.phase === 'idle') assert.equal(state.x, before.x)
      if (state.facing !== before.facing) {
        assert(state.activeMs - lastTurn >= roaming.MIN_PET_TURN_MS)
        lastTurn = state.activeMs; turns++
      }
      if (state.phase === 'moving') assert.equal(state.facing, state.targetX > state.fromX ? 'right' : 'left')
      phases.add(state.phase); faces.add(state.facing)
    }
    assert.deepEqual([...phases].sort(), ['idle','moving']); assert.equal(faces.size, 2); assert(turns > 2)
  }
})
test('pausing preserves the last position and direction without advancing background time', () => {
  const random = seeded(54)
  let state = roaming.createPetRoaming('dog', random)
  for (let i=0;i<100;i++) state=roaming.advancePetRoaming(state,100,random)
  const paused=roaming.pausePetRoaming(state)
  assert.equal(paused.x,state.x);assert.equal(paused.facing,state.facing);assert.equal(paused.activeMs,state.activeMs)
  assert.equal(paused.phase,'idle');assert.equal(paused.targetX,paused.x)
  for(const bad of [NaN,Infinity,-1,0]) assert.equal(roaming.advancePetRoaming(paused,bad,random),paused)
})

function pngInfo(bytes) {
  assert.equal(bytes.subarray(1,4).toString(),'PNG')
  const result={width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),frames:0,duration:0}
  for(let at=8;at+12<=bytes.length;) {
    const length=bytes.readUInt32BE(at),type=bytes.subarray(at+4,at+8).toString(),data=bytes.subarray(at+8,at+8+length)
    if(type==='acTL')result.frames=data.readUInt32BE(0)
    if(type==='fcTL')result.duration+=data.readUInt16BE(20)/(data.readUInt16BE(22)||100)*1000
    at+=12+length
  }
  return result
}
const asset = url => readFile(new URL('../public/'+url.replace(/^\//,''),import.meta.url))
test('every pet has real idle and movement clips, valid atlas coordinates, and a static reduced-motion image', async () => {
  for(const pet of registry.PETS) {
    for(const action of ['idle',registry.getPetMovingAction(pet.id)]) {
      const clip=pet.animations[action];assert(clip)
      const sheet=pngInfo(await asset(clip.spriteUrl??pet.spriteUrl)),columns=clip.columns??pet.columns,rows=clip.rows??pet.rows
      assert.equal(sheet.width,columns*(clip.frameWidth??pet.frameWidth));assert.equal(sheet.height,rows*(clip.frameHeight??pet.frameHeight))
      for(const [x,y]of clip.frames)assert(x>=0&&x<columns&&y>=0&&y<rows)
      const animation=pngInfo(await asset(clip.imageUrl)),still=pngInfo(await asset(clip.stillUrl))
      assert(animation.frames>=4);assert.equal(still.frames,0);assert.equal(animation.width,still.width);assert.equal(animation.height,still.height)
      assert.equal(Math.round(animation.duration),clip.frames.length*clip.frameMs)
    }
  }
})
