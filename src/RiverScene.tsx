import type { CSSProperties } from 'react'
import type { UsageAnalysis, UsageState } from './types/usage'
import { UsageBoard } from './components/UsageBoard'
import { deriveRiverEnvironment } from './game/riverEnvironment'

type RiverSceneProps = {
  usage: UsageState
  analysis: UsageAnalysis
  onStartFishing: () => void
  onOpenHome: () => void
  onOpenMailbox: () => void
  unreadMailCount: number
}

export function RiverScene({ usage, analysis, onStartFishing, onOpenHome, onOpenMailbox, unreadMailCount }: RiverSceneProps) {
  const environment = deriveRiverEnvironment(usage)
  const sceneStyle = {
    '--flow-duration': `${environment.flowDurationSeconds}s`,
    '--water-top': `${environment.waterTopPercent}%`,
  } as CSSProperties

  return (
    <div
      className={`river-scene phase-${environment.dayPhase} flow-${environment.flow} depth-${environment.depth} ${analysis.primary === 'freshReset' ? 'fresh-reset-river' : ''}`}
      style={sceneStyle}
      aria-label={`像素河边场景，流速${environment.flowLabel}，周额度水位${usage.weeklyRemaining}%`}
    >
      <div className="pixel-sky" aria-hidden="true">
        <div className="celestial" />
        <div className="pixel-stars"><i /><i /><i /><i /><i /></div>
        <div className="pixel-cloud cloud-one" />
        <div className="pixel-cloud cloud-two" />
      </div>
      <svg className="pixel-landscape" viewBox="0 0 760 510" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
        <path className="far-hills" d="M0 272V244H36V225H72V237H108V206H144V218H184V188H224V212H270V181H310V205H354V171H398V199H444V176H488V205H532V184H578V211H620V174H660V197H706V168H760V510H0Z" />
        <path className="near-hills" d="M0 315V284H58V264H102V278H150V246H201V270H252V238H300V265H352V232H405V258H458V236H512V270H568V244H620V273H672V238H716V258H760V510H0Z" />
        <path className="meadow" d="M0 374V323H62V310H126V322H188V300H254V316H318V294H382V312H446V299H510V320H572V301H638V318H700V298H760V510H0Z" />
        <g className="pixel-trees">
          <path d="M38 333h12v-47H30v-17H17v-17h18v-16h34v16h18v17H73v17H50v47z" />
          <path d="M671 326h12v-52h-22v-17h-14v-19h20v-17h34v17h19v19h-14v17h-23v52z" />
          <path d="M590 340h10v-38h-18v-15h-11v-17h16v-15h29v15h16v17h-11v15h-21v38z" />
          <path d="M238 338h9v-32h-15v-13h-9v-15h13v-13h25v13h14v15h-10v13h-18v32z" />
        </g>
        <g className="meadow-specks">
          <path d="M95 338h7v7h-7zm14-8h5v5h-5zm421 4h6v6h-6zm18 10h5v5h-5zM345 329h6v6h-6z" />
        </g>
      </svg>
      <div className="river-bank-back" aria-hidden="true">
        <i className="bank-rock bank-rock-a" /><i className="bank-rock bank-rock-b" /><i className="bank-rock bank-rock-c" />
        <i className="bank-flower flower-a" /><i className="bank-flower flower-b" /><i className="bank-flower flower-c" />
      </div>
      <div className="pixel-water" aria-hidden="true">
        <div className="water-shine shine-a" />
        <div className="water-shine shine-b" />
        <div className="water-shine shine-c" />
        <div className="water-spark spark-a" />
        <div className="water-spark spark-b" />
      </div>
      <div className="water-level-post" aria-hidden="true"><i /><i /><i /></div>
      <button className="pixel-house" onClick={onOpenHome} aria-label="进入河边小屋">
        <i className="house-roof" /><i className="house-chimney" /><i className="house-window" /><i className="house-door" />
        <span className="house-hint">进入小屋</span>
      </button>
      <button
        className={`pixel-mailbox ${unreadMailCount > 0 ? 'has-mail' : ''}`}
        onClick={onOpenMailbox}
        aria-label={unreadMailCount > 0 ? `打开邮箱，有${unreadMailCount}封新消息` : '打开邮箱'}
      >
        <i />
        {unreadMailCount > 0 && <b>{unreadMailCount}</b>}
        <span>{unreadMailCount > 0 ? '有新消息' : '邮箱'}</span>
      </button>
      <button className="fishing-spot" onClick={onStartFishing} aria-label="点击河面开始钓鱼">
        <i className="spot-ripple" />
        <span>🎣 点击河面钓鱼</span>
      </button>
      <div className="front-bank" aria-hidden="true">
        <i className="grass grass-a" /><i className="grass grass-b" /><i className="grass grass-c" />
        <i className="foreground-rock foreground-rock-a" /><i className="foreground-rock foreground-rock-b" />
        <i className="tiny-flower tiny-flower-a" /><i className="tiny-flower tiny-flower-b" /><i className="tiny-flower tiny-flower-c" />
      </div>
      <div className="reed reed-a"><i /><i /><i /></div>
      <div className="reed reed-b"><i /><i /><i /></div>
      <div className="environment-readout" aria-label="河流环境状态">
        <div><span>流速</span><strong>{environment.flowLabel}</strong></div>
        <div><span>周水位</span><strong>{usage.weeklyRemaining}%</strong></div>
        <div><span>时间</span><strong>{environment.dayLabel}</strong></div>
      </div>
      <div className="environment-key">流速＝当前消耗速度 · 水位＝周额度剩余</div>
      {analysis.primary === 'freshReset' && <div className="reset-tide">额度潮汐恢复</div>}
      <UsageBoard usage={usage} analysis={analysis} />
    </div>
  )
}
