import { useEffect, useMemo, useRef, useState } from 'react'
import { difficultyLabel } from '../game/fishSpecies'
import { classifyFishingPattern, generateFish } from '../game/fishingEngine'
import type { KeptFish } from '../types/collection'
import type { FishCatch } from '../types/fishing'
import type { UsageState } from '../types/usage'

type FishingPhase = 'ready' | 'waiting' | 'bite' | 'caught' | 'replace' | 'resolved' | 'failed'

type FishingGameProps = {
  usage: UsageState
  aquarium: KeptFish[]
  capacity: number
  onCatch: (fish: FishCatch) => void
  onKeep: (fish: FishCatch) => boolean
  onFeed: (fish: FishCatch) => void
  onRelease: (fish: FishCatch) => void
  onReplace: (incoming: FishCatch, outgoingId: string, disposition: 'fed' | 'released') => void
  onClose: () => void
}

export function FishingGame({ usage, aquarium, capacity, onCatch, onKeep, onFeed, onRelease, onReplace, onClose }: FishingGameProps) {
  const [phase, setPhase] = useState<FishingPhase>('ready')
  const [candidate, setCandidate] = useState<FishCatch | null>(null)
  const [failure, setFailure] = useState('')
  const [resolution, setResolution] = useState('')
  const [replacementId, setReplacementId] = useState('')
  const [decided, setDecided] = useState(false)
  const biteTimer = useRef<number | null>(null)
  const escapeTimer = useRef<number | null>(null)
  const round = useRef(0)
  const pattern = useMemo(() => classifyFishingPattern(usage), [usage])

  const clearTimers = () => {
    if (biteTimer.current) window.clearTimeout(biteTimer.current)
    if (escapeTimer.current) window.clearTimeout(escapeTimer.current)
    biteTimer.current = null
    escapeTimer.current = null
  }

  useEffect(() => clearTimers, [])

  const cast = () => {
    clearTimers()
    const currentRound = ++round.current
    const nextCatch = generateFish(usage)
    setCandidate(nextCatch)
    setFailure('')
    setResolution('')
    setReplacementId('')
    setDecided(false)
    setPhase('waiting')
    biteTimer.current = window.setTimeout(() => {
      if (round.current !== currentRound) return
      setPhase('bite')
      escapeTimer.current = window.setTimeout(() => {
        if (round.current !== currentRound) return
        setFailure('慢了一点，它溜走了。')
        setPhase('failed')
      }, nextCatch.species.reactionWindowMs)
    }, 850 + Math.random() * 1_150)
  }

  const pull = () => {
    if (phase === 'waiting') {
      round.current += 1
      clearTimers()
      setFailure('太早了，现在还没有鱼咬钩。')
      setPhase('failed')
      return
    }
    if (phase === 'bite') {
      round.current += 1
      clearTimers()
      onCatch(candidate!)
      setPhase('caught')
    }
  }

  const keep = () => {
    if (!candidate) return
    if (onKeep(candidate)) {
      setDecided(true)
      setResolution(`${candidate.species.name}已经住进水族箱。`)
      setPhase('resolved')
      return
    }
    setReplacementId(aquarium[0]?.id ?? '')
    setPhase('replace')
  }

  const feed = () => {
    if (!candidate) return
    setDecided(true)
    onFeed(candidate)
  }

  const release = () => {
    if (!candidate) return
    setDecided(true)
    onRelease(candidate)
    setResolution(`${candidate.species.name}回到了河里。`)
    setPhase('resolved')
  }

  const replace = (disposition: 'fed' | 'released') => {
    if (!candidate || !replacementId) return
    setDecided(true)
    onReplace(candidate, replacementId, disposition)
    if (disposition === 'released') {
      setResolution(`旧鱼已经放生，${candidate.species.name}住进了水族箱。`)
      setPhase('resolved')
    }
  }

  const closeGame = () => {
    if (candidate && (phase === 'caught' || phase === 'replace') && !decided) onRelease(candidate)
    onClose()
  }

  return (
    <section className="fishing-game" aria-label="手动钓鱼小游戏">
      <button className="fishing-close" onClick={closeGame} aria-label="返回河边">×</button>
      <div className="fishing-header">
        <span>FISHING · STAGE 4</span>
        <strong>{pattern.label}</strong>
        <small>当前习惯会改变鱼的出现概率</small>
      </div>

      <div className={`fishing-water phase-${phase}`}>
        <div className="fishing-current current-one" />
        <div className="fishing-current current-two" />
        <div className="bobber"><i /></div>
        {phase === 'bite' && <div className="bite-mark">!</div>}
        {phase === 'waiting' && <div className="waiting-ripple" />}
      </div>

      {phase === 'ready' && (
        <div className="fishing-card fishing-intro">
          <span>点击抛竿，然后等待浮标出现“！”</span>
          <strong>太早或太晚都会失败，但没有任何损失。</strong>
          <button onClick={cast}>抛竿</button>
        </div>
      )}

      {(phase === 'waiting' || phase === 'bite') && candidate && (
        <button
          className={`pull-button ${phase === 'bite' ? 'is-biting' : ''}`}
          onClick={pull}
          style={{ '--bite-window': `${candidate.species.reactionWindowMs}ms` } as React.CSSProperties}
        >
          <span>{phase === 'bite' ? '现在！点击收竿' : '等待咬钩……'}</span>
          <i />
        </button>
      )}

      {phase === 'failed' && (
        <div className="fishing-card fishing-result is-failed" role="status">
          <span>这次没钓到</span>
          <strong>{failure}</strong>
          <button onClick={cast}>立即重试</button>
        </div>
      )}

      {phase === 'caught' && candidate && (
        <div className="fishing-card fishing-result is-caught" role="status">
          <div
            className={`caught-fish fish-${candidate.species.id}`}
            style={{
              '--fish-body': candidate.species.bodyColor,
              '--fish-accent': candidate.species.accentColor,
            } as React.CSSProperties}
            aria-hidden="true"
          ><i /></div>
          <span>NEW CATCH</span>
          <strong>{candidate.species.name}</strong>
          <p>{candidate.length.toFixed(1)} cm · {difficultyLabel(candidate.species.difficulty)}</p>
          <small>{candidate.species.description}</small>
          <div className="catch-snapshot">
            <b>捕获快照</b>
            <em>5h {Math.round(candidate.usageSnapshot.shortWindowRemaining)}%</em>
            <em>周 {Math.round(candidate.usageSnapshot.weeklyRemaining)}%</em>
            <em>{candidate.usageSnapshot.burnRate.toFixed(1)}%/h</em>
          </div>
          <div className="catch-actions" aria-label="处理这条鱼">
            <button className="keep-action" onClick={keep}>保留</button>
            <button className="feed-action" onClick={feed}>喂给布罗艾</button>
            <button className="release-action" onClick={release}>放生</button>
          </div>
        </div>
      )}

      {phase === 'replace' && candidate && (
        <div className="fishing-card replacement-card" role="dialog" aria-label="水族箱已满">
          <span>AQUARIUM FULL · {aquarium.length}/{capacity}</span>
          <strong>选择一条旧鱼，让新鱼住进来</strong>
          <p>新鱼：{candidate.species.name} · {candidate.length.toFixed(1)} cm</p>
          <div className="replacement-list">
            {aquarium.map((fish) => (
              <label key={fish.id} className={replacementId === fish.id ? 'is-selected' : ''}>
                <input type="radio" name="replacement" checked={replacementId === fish.id} onChange={() => setReplacementId(fish.id)} />
                <span>{fish.species.name}</span><b>{fish.length.toFixed(1)} cm</b>
              </label>
            ))}
          </div>
          <div className="replacement-actions">
            <button className="feed-action" onClick={() => replace('fed')}>旧鱼喂给布罗艾</button>
            <button className="release-action" onClick={() => replace('released')}>旧鱼放生</button>
          </div>
        </div>
      )}

      {phase === 'resolved' && (
        <div className="fishing-card fishing-result resolved-card" role="status">
          <span>处理完成</span><strong>{resolution}</strong>
          <button onClick={cast}>继续钓鱼</button>
          <button className="quiet-action" onClick={closeGame}>返回河边</button>
        </div>
      )}
    </section>
  )
}
