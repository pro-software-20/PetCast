import { useMemo, useState } from 'react'
import { FISH_SPECIES, difficultyLabel } from '../game/fishSpecies'
import type { CodexState, FishDisposition, KeptFish } from '../types/collection'

type HomeSceneProps = {
  aquarium: KeptFish[]
  codex: CodexState
  capacity: number
  onClose: () => void
  onFeed: (fish: KeptFish) => void
  onRelease: (fish: KeptFish) => void
}

export function HomeScene({ aquarium, codex, capacity, onClose, onFeed, onRelease }: HomeSceneProps) {
  const [view, setView] = useState<'room' | 'codex'>('room')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selectedFish = aquarium.find((fish) => fish.id === selectedId) ?? null
  const discovered = useMemo(() => FISH_SPECIES.filter((species) => codex[species.id].discovered).length, [codex])

  const handleDisposition = (fish: KeptFish, disposition: Exclude<FishDisposition, 'kept'>) => {
    setSelectedId(null)
    if (disposition === 'fed') onFeed(fish)
    else onRelease(fish)
  }

  return (
    <section className="home-scene" aria-label="布罗艾的河边小屋">
      <button className="home-back" onClick={onClose}>← 返回河边</button>
      <div className="home-title"><span>BLAHAJ'S HOME</span><strong>布罗艾的小屋</strong></div>
      <div className="home-window" aria-hidden="true"><i /><i /></div>
      <button className="codex-frame" onClick={() => setView('codex')} aria-label="打开墙上的鱼类图鉴">
        <span>鱼类图鉴</span><strong>{discovered} / {FISH_SPECIES.length}</strong><i>🐟</i>
      </button>
      <div className="home-shelf" aria-hidden="true"><i /><i /><i /></div>
      <div className="home-rug" aria-hidden="true" />
      <div className="home-lamp" aria-hidden="true"><i /></div>

      <section className="aquarium-unit" aria-label={`水族箱，已放入${aquarium.length}条鱼，容量${capacity}`}>
        <header><span>水族箱</span><strong>{aquarium.length} / {capacity}</strong></header>
        <div className="aquarium-glass">
          <i className="tank-plant plant-one" /><i className="tank-plant plant-two" />
          <i className="tank-bubble bubble-one" /><i className="tank-bubble bubble-two" />
          {aquarium.length === 0 && <p>这里还没有鱼<br />去河边钓一条吧</p>}
          {aquarium.map((fish, index) => (
            <button
              key={fish.id}
              className={`tank-fish tank-fish-${index + 1}`}
              style={{
                '--fish-body': fish.species.bodyColor,
                '--fish-accent': fish.species.accentColor,
                '--swim-delay': `${index * -1.3}s`,
                '--swim-duration': `${6 + index * .75}s`,
              } as React.CSSProperties}
              onClick={() => setSelectedId(fish.id)}
              aria-label={`查看${fish.species.name}，${fish.length.toFixed(1)}厘米`}
            ><i /></button>
          ))}
        </div>
        <small>点击游动的鱼查看个体信息</small>
      </section>

      {view === 'codex' && (
        <div className="home-panel codex-panel" role="dialog" aria-label="鱼类图鉴">
          <header><div><span>WALL CODEX</span><strong>鱼类图鉴</strong></div><button onClick={() => setView('room')}>×</button></header>
          <p className="codex-summary">只要成功钓到就会永久点亮 · 已发现 {discovered}/{FISH_SPECIES.length}</p>
          <div className="codex-grid">
            {FISH_SPECIES.map((species) => {
              const entry = codex[species.id]
              const keptCount = aquarium.filter((fish) => fish.species.id === species.id).length
              return (
                <article key={species.id} className={entry.discovered ? 'is-discovered' : 'is-unknown'}>
                  <div className="codex-fish" style={{ '--fish-body': species.bodyColor, '--fish-accent': species.accentColor } as React.CSSProperties}><i /></div>
                  <span>{entry.discovered ? difficultyLabel(species.difficulty) : '尚未发现'}</span>
                  <strong>{entry.discovered ? species.name : '???'}</strong>
                  {entry.discovered ? (
                    <>
                      <p>{species.description}</p>
                      <dl>
                        <div><dt>捕获</dt><dd>{entry.caughtCount}</dd></div>
                        <div><dt>水箱</dt><dd>{keptCount}</dd></div>
                        <div><dt>喂食</dt><dd>{entry.fedCount}</dd></div>
                        <div><dt>放生</dt><dd>{entry.releasedCount}</dd></div>
                      </dl>
                      <small>最大 {entry.largestLength?.toFixed(1)} cm · 首次 {entry.firstCaughtAt ? new Date(entry.firstCaughtAt).toLocaleDateString('zh-CN') : '—'}</small>
                    </>
                  ) : <p>提示：留意不同的使用节奏和时间。</p>}
                </article>
              )
            })}
          </div>
        </div>
      )}

      {selectedFish && (
        <div className="fish-detail" role="dialog" aria-label={`${selectedFish.species.name}个体信息`}>
          <button className="detail-close" onClick={() => setSelectedId(null)}>×</button>
          <div className="detail-fish" style={{ '--fish-body': selectedFish.species.bodyColor, '--fish-accent': selectedFish.species.accentColor } as React.CSSProperties}><i /></div>
          <span>水族箱个体</span><strong>{selectedFish.species.name}</strong>
          <p>{selectedFish.length.toFixed(1)} cm · {difficultyLabel(selectedFish.species.difficulty)}</p>
          <small>捕获时：5h {Math.round(selectedFish.usageSnapshot.shortWindowRemaining)}% · 周 {Math.round(selectedFish.usageSnapshot.weeklyRemaining)}%</small>
          <div className="detail-actions">
            <button className="feed-action" onClick={() => handleDisposition(selectedFish, 'fed')}>喂给布罗艾</button>
            <button className="release-action" onClick={() => handleDisposition(selectedFish, 'released')}>放生</button>
          </div>
        </div>
      )}
    </section>
  )
}
