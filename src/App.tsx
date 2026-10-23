import { useEffect, useMemo, useRef, useState } from 'react'
import { CompactDevice, type MainPage } from './components/CompactDevice'
import { AppearanceSettings } from './components/AppearanceSettings'
import { loadAppearance } from './appearance/preferences'
import { RiverScene } from './RiverScene'
import { MockUsageControls } from './components/MockUsageControls'
import { UsageBoard } from './components/UsageBoard'
import { FishingGame } from './components/FishingGame'
import { HomeScene } from './components/HomeScene'
import { MailboxPanel } from './components/MailboxPanel'
import { TaskAnalysisPanel } from './components/TaskAnalysisPanel'
import { AQUARIUM_CAPACITY, createEmptyCodex, recordCatch, recordDisposition, replaceAquariumFish, toKeptFish } from './game/collection'
import { generateAutoFishingRound } from './game/autoFishing'
import { analyzeUsage, isProactiveUsageFlag, resetConfirmationMessage } from './game/usageAnalysis'
import { createGameSave, loadGameSave, restoreGameSave, saveGame } from './persistence/storage'
import type { KeptFish } from './types/collection'
import type { FishCatch } from './types/fishing'
import type { AutoFishingReport, MailItem, ResetCompletedNotice } from './types/notifications'
import type { UsageScenarioId, UsageState } from './types/usage'
import { createMockUsageState, MockUsageProvider } from './usage/MockUsageProvider'
import { MockResetSignalProvider } from './usage/MockResetSignalProvider'
import { useUsageConnection } from './usage/useUsageConnection'
import { UsageSettings, usageStatus } from './components/UsageSettings'
import { UsageHistoryPanel } from './components/UsageHistoryPanel'
import { useUsageHistory } from './history/useUsageHistory'

export default function App() {
  const desktopApi = window.petcast
  const isBrowserFallback = !desktopApi
  const mockUsageProvider = useMemo(() => new MockUsageProvider('balanced'), [])
  const resetSignalProvider = useMemo(() => new MockResetSignalProvider(), [])
  const [expanded, setExpanded] = useState(false)
  const [page, setPage] = useState<MainPage>('home')
  const [appearance, setAppearance] = useState(loadAppearance)
  const [dragging, setDragging] = useState(false)
  const [dragDirection, setDragDirection] = useState<'left' | 'right'>('right')
  const [mockSaveUsage, setMockSaveUsage] = useState(() => createMockUsageState('balanced'))
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [bubbleVisible, setBubbleVisible] = useState(false)
  const [reaction, setReaction] = useState<'wave' | 'eat' | null>(null)
  const [fishingOpen, setFishingOpen] = useState(false)
  const [homeOpen, setHomeOpen] = useState(false)
  const [mailboxOpen, setMailboxOpen] = useState(false)
  const [taskAnalysisOpen, setTaskAnalysisOpen] = useState(false)
  const mailboxOpenRef = useRef(mailboxOpen)
  const [aquarium, setAquarium] = useState<KeptFish[]>([])
  const [codex, setCodex] = useState(createEmptyCodex)
  const codexRef = useRef(codex)
  const [mailItems, setMailItems] = useState<MailItem[]>([])
  const mailItemsRef = useRef<MailItem[]>([])
  const [unreadMailIds, setUnreadMailIds] = useState<string[]>([])
  const [autoFishingEnabled, setAutoFishingEnabled] = useState(false)
  const [autoFishingNextAt, setAutoFishingNextAt] = useState<number | null>(null)
  const [resetWatchEnabled, setResetWatchEnabled] = useState(true)
  const [resetWatchNextAt, setResetWatchNextAt] = useState<number | null>(() => Date.now() + 10 * 60_000)
  const [resetCheckStatus, setResetCheckStatus] = useState<'idle' | 'checking' | 'error'>('idle')
  const [saveReady, setSaveReady] = useState(false)
  const connection = useUsageConnection(mockUsageProvider, desktopApi, saveReady)
  const history = useUsageHistory(connection.reading, desktopApi)
  const [historyOpen, setHistoryOpen] = useState(false)
  const usage = connection.reading?.data ?? null
  const historyScope = connection.source === 'mock' ? {source: 'mock' as const, scopeId: 'mock-local'} : usage?.scopeId ? {source: 'real' as const, scopeId: usage.scopeId} : null
  const fresh = connection.reading?.status === 'fresh'
  const usageRef = useRef<UsageState | null>(usage)
  const sourceRef = useRef(connection.source)
  sourceRef.current = connection.source
  const freshRef = useRef(fresh)
  usageRef.current = usage
  freshRef.current = fresh
  const usageReadStatus = usageStatus(connection)
  const [saveStatus, setSaveStatus] = useState<'loading' | 'saving' | 'saved' | 'error'>('loading')
  const initialMailSeeded = useRef(false)
  const lastProactiveAlert = useRef<string | null>(null)
  const [bubbleMessage, setBubbleMessage] = useState<string | null>(null)
  const [browserPosition, setBrowserPosition] = useState({ x: 0, y: 0 })
  const browserDragOrigin = useRef({ pointerX: 0, pointerY: 0, cardX: 0, cardY: 0 })
  const lastPointerScreenX = useRef(0)
  const lastPointerScreenY = useRef(0)
  const dragDistance = useRef(0)
  const petPointerStart = useRef(false)
  const bubbleTimer = useRef<number | null>(null)
  const reactionTimer = useRef<number | null>(null)
  const analysis = useMemo(() => usage ? analyzeUsage(usage) : null, [usage])

  const showPetMessage = (message?: string) => {
    if (dragDistance.current > 5) return
    setBubbleVisible(true)
    setBubbleMessage(message ?? null)
    setReaction('wave')
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubbleVisible(false), 4_500)
    reactionTimer.current = window.setTimeout(() => setReaction(null), 1_350)
  }

  const showFeedReaction = (fishName: string) => {
    setFishingOpen(false)
    setHomeOpen(false)
    setBubbleMessage(`谢谢！${fishName}很好吃，${appearance.petName || '布罗艾'}开心地摇了摇尾巴。`)
    setBubbleVisible(true)
    setReaction('eat')
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubbleVisible(false), 4_500)
    reactionTimer.current = window.setTimeout(() => setReaction(null), 1_800)
  }

  const showStageSixNotice = (message: string) => {
    setBubbleMessage(message)
    setBubbleVisible(true)
    setReaction('wave')
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current)
    bubbleTimer.current = window.setTimeout(() => setBubbleVisible(false), 5_500)
    reactionTimer.current = window.setTimeout(() => setReaction(null), 1_350)
  }

  const addMailItem = (item: MailItem) => {
    if (mailItemsRef.current.some((current) => current.id === item.id)) return false
    const nextItems = [item, ...mailItemsRef.current].slice(0, 30)
    mailItemsRef.current = nextItems
    setMailItems(nextItems)
    if (!mailboxOpenRef.current) {
      setUnreadMailIds((current) => [item.id, ...current].slice(0, 30))
    }
    return true
  }

  const triggerMockResetSignal = async () => {
    if (connection.source !== 'mock') return
    setResetCheckStatus('checking')
    try {
      const signal = await resetSignalProvider.getLatestSignal()
      if (sourceRef.current !== 'mock') return
      const isNew = addMailItem(signal)
      if (resetWatchEnabled) setResetWatchNextAt(Date.now() + 10 * 60_000)
      setResetCheckStatus('idle')
      showStageSixNotice(isNew
        ? `模拟邮箱收到来自 ${signal.handle} 的${signal.resetType === 'short' ? '5h' : '周'}额度重置线索。点击信封查看。`
        : '已经检查到最新动态，目前没有新的重置线索。')
    } catch {
      setResetCheckStatus('error')
      showStageSixNotice('暂时无法检查重置动态，稍后会自动重试。')
    }
  }

  const toggleResetWatch = () => {
    const next = !resetWatchEnabled
    setResetWatchEnabled(next)
    setResetWatchNextAt(next ? Date.now() + 10 * 60_000 : null)
    showStageSixNotice(next ? '重置动态监测已开启。' : '重置动态监测已暂停，已有信件仍会保留。')
  }

  const runAutoFishing = () => {
    if (!freshRef.current || !usageRef.current) return
    const currentCodex = codexRef.current
    const { catches, nextCodex, newSpeciesIds } = generateAutoFishingRound(usageRef.current, currentCodex)
    codexRef.current = nextCodex
    setCodex(nextCodex)
    const report: AutoFishingReport = {
      id: `auto-fishing-${Date.now()}`,
      type: 'autoFishing',
      createdAt: new Date().toISOString(),
      fish: catches.map((fish) => ({ speciesId: fish.species.id, name: fish.species.name, length: fish.length })),
      newSpeciesIds,
    }
    addMailItem(report)
    showStageSixNotice(`布罗艾自动钓到了3条鱼，其中有${newSpeciesIds.length}条新鱼！图鉴已经更新。`)
  }

  const toggleAutoFishing = () => {
    if (!autoFishingEnabled && !freshRef.current) return
    const next = !autoFishingEnabled
    setAutoFishingEnabled(next)
    if (next) {
      runAutoFishing()
      setAutoFishingNextAt(Date.now() + 5 * 60_000)
    } else {
      setAutoFishingNextAt(null)
      showStageSixNotice('自动钓鱼已暂停，手动钓鱼仍然可以正常使用。')
    }
  }

  const runAutoFishingNow = () => {
    runAutoFishing()
    if (autoFishingEnabled) setAutoFishingNextAt(Date.now() + 5 * 60_000)
  }

  const clearCodexHistory = () => {
    const emptyCodex = createEmptyCodex()
    codexRef.current = emptyCodex
    setCodex(emptyCodex)
    showStageSixNotice('鱼类图鉴历史已经清空，水族箱里的鱼仍然保留。')
  }

  const openMailbox = async () => {
    setPage('home')
    if (!expanded) {
      setExpanded(true)
      await desktopApi?.toggleExpanded(true)
    }
    setFishingOpen(false)
    setHomeOpen(false)
    setTaskAnalysisOpen(false)
    setHistoryOpen(false)
    setMailboxOpen(true)
    setUnreadMailIds([])
  }

  const openTaskAnalysis = async () => {
    setPage('tasks')
    if (!expanded) {
      setExpanded(true)
      await desktopApi?.toggleExpanded(true)
    }

    setFishingOpen(false)
    setHomeOpen(false)
    setMailboxOpen(false)
    setHistoryOpen(false)
    setTaskAnalysisOpen(true)
  }

  const closeTaskAnalysis = () => {
    setPage('home')
    setTaskAnalysisOpen(false)
  }

  const handleCatch = (fish: FishCatch) => setCodex((current) => recordCatch(current, fish))

  const handleKeep = (fish: FishCatch) => {
    if (aquarium.length >= AQUARIUM_CAPACITY) return false
    setAquarium((current) => [...current, toKeptFish(fish)])
    return true
  }

  const handleFeedCatch = (fish: FishCatch) => {
    setCodex((current) => recordDisposition(current, fish.species.id, 'fed'))
    showFeedReaction(fish.species.name)
  }

  const handleReleaseCatch = (fish: FishCatch) => {
    setCodex((current) => recordDisposition(current, fish.species.id, 'released'))
  }

  const handleReplaceFish = (incoming: FishCatch, outgoingId: string, disposition: 'fed' | 'released') => {
    const outgoing = aquarium.find((fish) => fish.id === outgoingId)
    if (!outgoing) return
    setAquarium((current) => replaceAquariumFish(current, incoming, outgoingId))
    setCodex((current) => recordDisposition(current, outgoing.species.id, disposition))
    if (disposition === 'fed') showFeedReaction(outgoing.species.name)
  }

  const handleStoredFish = (fish: KeptFish, disposition: 'fed' | 'released') => {
    setAquarium((current) => current.filter((item) => item.id !== fish.id))
    setCodex((current) => recordDisposition(current, fish.species.id, disposition))
    if (disposition === 'fed') showFeedReaction(fish.species.name)
  }

  useEffect(() => {
    let active = true
    void loadGameSave().then((rawSave) => {
      if (!active) return
      const restored = restoreGameSave(rawSave, createMockUsageState('balanced'))
      if (restored) {
        const { save, usage: restoredUsage } = restored
        mockUsageProvider.update(restoredUsage)
        setMockSaveUsage(restoredUsage)
        codexRef.current = save.codex
        mailItemsRef.current = save.mailItems
        setAquarium(save.aquarium)
        setCodex(save.codex)
        setMailItems(save.mailItems)
        setUnreadMailIds(save.unreadMailIds)
        setAutoFishingEnabled(save.autoFishingEnabled)
        setAutoFishingNextAt(save.autoFishingEnabled ? Date.now() + 5 * 60_000 : null)
        setResetWatchEnabled(save.resetWatchEnabled)
        setResetWatchNextAt(save.resetWatchEnabled ? Date.now() + 10 * 60_000 : null)
      }
      setSaveStatus('saved')
    }).catch(() => {
      if (active) setSaveStatus('error')
    }).finally(() => {
      if (active) setSaveReady(true)
    })
    return () => { active = false }
  }, [mockUsageProvider])

  useEffect(() => {
    if (!saveReady) return
    setSaveStatus('saving')
    let active = true
    const timer = window.setTimeout(() => {
      const snapshot = createGameSave({
        aquarium,
        codex,
        mailItems,
        unreadMailIds,
        autoFishingEnabled,
        resetWatchEnabled,
        usage: mockSaveUsage,
      })
      void saveGame(snapshot).then(() => {
        if (active) setSaveStatus('saved')
      }).catch(() => {
        if (active) setSaveStatus('error')
      })
    }, 250)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [aquarium, autoFishingEnabled, codex, mailItems, resetWatchEnabled, saveReady, unreadMailIds, mockSaveUsage])

  useEffect(() => {
    if (connection.source === 'mock' && fresh && usage) setMockSaveUsage(usage)
  }, [connection.source, fresh, usage])

  useEffect(() => {
    setFishingOpen(false)
    setBubbleVisible(false)
    lastProactiveAlert.current = null
  }, [connection.source, fresh, usage?.scopeId])

  useEffect(() => {
    if (!saveReady || connection.source !== 'mock' || initialMailSeeded.current) return
    let active = true
    void resetSignalProvider.getLatestSignal().then((signal) => {
      if (!active || mailItemsRef.current.length > 0) return
      initialMailSeeded.current = true
      mailItemsRef.current = [signal]
      setMailItems([signal])
      setUnreadMailIds([signal.id])
    })
    return () => { active = false }
  }, [resetSignalProvider, saveReady, connection.source])

  useEffect(() => {
    if (!saveReady || connection.source !== 'mock' || !resetWatchEnabled) return
    const timer = window.setInterval(() => {
      void triggerMockResetSignal()
    }, 10 * 60_000)
    return () => window.clearInterval(timer)
  }, [resetWatchEnabled, resetSignalProvider, saveReady, connection.source])

  useEffect(() => {
    codexRef.current = codex
  }, [codex])

  useEffect(() => {
    mailboxOpenRef.current = mailboxOpen
  }, [mailboxOpen])

  useEffect(() => {
    usageRef.current = usage
  }, [usage])

  useEffect(() => {
    if (!fresh || !usage?.recentResetType) return
    const resetType = usage.recentResetType
    const notice: ResetCompletedNotice = {
      id: `reset-completed-${connection.source}-${usage.scopeId ?? "demo"}-${resetType}-${usage.sampledAt.getTime()}`,
      type: 'resetCompleted',
      source: connection.source,
      createdAt: usage.sampledAt.toISOString(),
      resetType,
    }
    addMailItem(notice)
    showStageSixNotice(resetConfirmationMessage(usage))
  }, [fresh, connection.source, usage?.recentResetType, usage?.sampledAt])

  useEffect(() => {
    if (!fresh || !analysis || !isProactiveUsageFlag(analysis.primary)) {
      lastProactiveAlert.current = null
      return
    }
    if (lastProactiveAlert.current === analysis.primary) return
    lastProactiveAlert.current = analysis.primary
    showStageSixNotice(analysis.message)
  }, [fresh, analysis?.primary, analysis?.message])

  useEffect(() => {
    if (!saveReady || !autoFishingEnabled || !fresh) { setAutoFishingNextAt(null); return }
    setAutoFishingNextAt(Date.now() + 5 * 60_000)
    const timer = window.setInterval(() => {
      runAutoFishing()
      setAutoFishingNextAt(Date.now() + 5 * 60_000)
    }, 5 * 60_000)
    return () => window.clearInterval(timer)
  }, [autoFishingEnabled, saveReady, fresh, connection.source, usage?.scopeId])

  useEffect(() => () => {
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current)
    if (reactionTimer.current) window.clearTimeout(reactionTimer.current)
  }, [])

  useEffect(() => {
    const finish = () => {
      if (!dragging) return
      desktopApi?.endDrag()
      setDragging(false)
      if (petPointerStart.current && dragDistance.current <= 5) showPetMessage()
      petPointerStart.current = false
    }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [desktopApi, dragging])

  const startDrag = (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, select, a, [role=slider], [role=group], .task-analysis-panel, .usage-history-panel, .mailbox-panel, .appearance-frame, .quota-page-panel, .fishing-game, .home-panel, .fish-detail')) return
    setDragging(true)
    dragDistance.current = 0
    petPointerStart.current = Boolean((event.target as HTMLElement).closest('.pet-wrap'))
    lastPointerScreenX.current = event.screenX
    lastPointerScreenY.current = event.screenY
    event.currentTarget.setPointerCapture(event.pointerId)
    if (desktopApi) {
      desktopApi.beginDrag()
    } else {
      browserDragOrigin.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        cardX: browserPosition.x,
        cardY: browserPosition.y,
      }
    }
  }

  const moveDrag = (event: React.PointerEvent) => {
    if (!dragging || !event.buttons) return
    const horizontalDelta = event.screenX - lastPointerScreenX.current
    const verticalDelta = event.screenY - lastPointerScreenY.current
    dragDistance.current += Math.hypot(horizontalDelta, verticalDelta)
    if (Math.abs(horizontalDelta) >= 1) {
      setDragDirection(horizontalDelta < 0 ? 'left' : 'right')
    }
    lastPointerScreenX.current = event.screenX
    lastPointerScreenY.current = event.screenY
    if (desktopApi) {
      desktopApi.moveDrag()
    } else {
      const origin = browserDragOrigin.current
      setBrowserPosition({
        x: origin.cardX + event.clientX - origin.pointerX,
        y: origin.cardY + event.clientY - origin.pointerY,
      })
    }
  }

  const toggleExpanded = async () => {
    const next = !expanded
    if (!next) {
      setFishingOpen(false)
      setHomeOpen(false)
      setMailboxOpen(false)
      setTaskAnalysisOpen(false)
      setHistoryOpen(false)
    }
    setExpanded(next)
    await desktopApi?.toggleExpanded(next)
  }

  const selectScenario = async (scenario: UsageScenarioId) => {
    if (connection.source !== 'mock') return
    mockUsageProvider.setScenario(scenario)
    const nextUsage = (await connection.refresh())?.data
    if (!nextUsage) return
    const nextAnalysis = analyzeUsage(nextUsage)
    dragDistance.current = 0
    lastProactiveAlert.current = isProactiveUsageFlag(nextAnalysis.primary) ? nextAnalysis.primary : null
    showPetMessage(nextAnalysis.message)
  }

  const patchUsage = async (patch: Partial<UsageState>) => {
    if (connection.source !== 'mock') return
    mockUsageProvider.update(patch)
    await connection.refresh()
  }

  const navigate = async (target: MainPage) => {
    setPage(target)
    setFishingOpen(false); setHomeOpen(false); setMailboxOpen(false); setHistoryOpen(false); setSettingsOpen(false)
    setTaskAnalysisOpen(target === 'tasks')
    if (!expanded) { setExpanded(true); await desktopApi?.toggleExpanded(true) }
  }
  const openRoom = () => {
    setPage('home'); setFishingOpen(false); setMailboxOpen(false); setTaskAnalysisOpen(false); setHistoryOpen(false); setHomeOpen(true)
  }
  const openHistory = () => {
    setPage('quota'); setFishingOpen(false); setHomeOpen(false); setMailboxOpen(false); setTaskAnalysisOpen(false); setHistoryOpen(true)
  }
  return (
    <main className={`app petcast-warm ${isBrowserFallback ? 'browser-mode' : 'desktop-mode'} ${expanded ? 'expanded' : 'compact'} ${dragging ? 'dragging' : ''}`}
      data-drag-direction={dragDirection} data-usage-source={connection.source} data-history-status={history.recordingState} data-usage-status={connection.reading?.status ?? 'loading'} data-page={expanded ? page : 'compact'}>
      <section className="card" style={isBrowserFallback ? { transform: `translate(${browserPosition.x}px, ${browserPosition.y}px)` } : undefined} onPointerDown={startDrag} onPointerMove={moveDrag}>
        {!expanded && <CompactDevice appearance={appearance} usage={usage} status={usageReadStatus} stale={!fresh} onNavigate={target => void navigate(target)} onClose={desktopApi ? () => desktopApi.close() : undefined} />}
        {expanded && <>
          <RiverScene usage={usage} analysis={analysis} appearance={appearance} status={usageReadStatus} stale={!fresh}
            onStartFishing={() => { setHomeOpen(false); setMailboxOpen(false); setTaskAnalysisOpen(false); setHistoryOpen(false); if (fresh) setFishingOpen(true) }}
            onOpenHome={openRoom} onOpenMailbox={openMailbox} unreadMailCount={unreadMailIds.length} />
          {homeOpen && page === 'home' && <HomeScene aquarium={aquarium} codex={codex} capacity={AQUARIUM_CAPACITY} petId={appearance.petId} petName={appearance.petName || '布罗艾'} onClose={() => setHomeOpen(false)} onFeed={fish => handleStoredFish(fish, 'fed')} onRelease={fish => handleStoredFish(fish, 'released')} />}
          {page === 'appearance' && <AppearanceSettings value={appearance} onChange={setAppearance} onClose={() => void navigate('home')} />}
          {page === 'quota' && !historyOpen && <section className="quota-page" aria-label="真实额度页面"><div className="room-art" /><div className="room-nameplate">{appearance.petName || '布罗艾'}的小屋</div><div className="quota-page-panel"><h1>额度数据</h1><UsageSettings state={connection} desktop={!isBrowserFallback} onSelect={connection.select} onRefresh={() => void connection.refresh()} /><UsageBoard usage={usage} analysis={analysis} stale={!fresh} status={usageReadStatus} /></div></section>}
          {fishingOpen && fresh && usage && <FishingGame usage={usage} petName={appearance.petName} aquarium={aquarium} capacity={AQUARIUM_CAPACITY} onCatch={handleCatch} onKeep={handleKeep} onFeed={handleFeedCatch} onRelease={handleReleaseCatch} onReplace={handleReplaceFish} onClose={() => setFishingOpen(false)} />}
          {mailboxOpen && <MailboxPanel items={mailItems} usage={fresh ? usage : null} onClose={() => setMailboxOpen(false)} />}
          {taskAnalysisOpen && page === 'tasks' && <TaskAnalysisPanel onClose={closeTaskAnalysis} />}
          {historyOpen && <UsageHistoryPanel key={`${historyScope?.source}-${historyScope?.scopeId}`} scope={historyScope} store={history.store} currentQuota={historyScope && usage ? { ...historyScope, fresh, sampledAt: usage.sampledAt.toISOString(), shortRemaining: usage.shortWindowRemaining, weeklyRemaining: usage.weeklyRemaining, shortResetAt: usage.shortWindowResetAt.toISOString(), weeklyResetAt: usage.weeklyResetAt.toISOString() } : null} revision={history.revision} recordStatus={history.status} onClear={scope => history.recorder.clear(scope)} onClose={() => setHistoryOpen(false)} />}
          <nav className="wood-nav" aria-label="主导航">{([{ id: 'home', label: '主页' }, { id: 'appearance', label: '形象' }, { id: 'tasks', label: '任务分析' }, { id: 'quota', label: '真实额度' }] as const).map(item => <button key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => void navigate(item.id)}>{item.label}</button>)}</nav>
          <header className="warm-window-actions"><span title={usageReadStatus}>{usageReadStatus}</span>{desktopApi && <button className="close" onClick={() => desktopApi.close()} aria-label="关闭">×</button>}</header>
          <button className="expand-button" onClick={toggleExpanded} aria-label="收起场景"><span>收起</span></button>
        </>}
        {expanded && unreadMailIds.length > 0 && <button className="notification-envelope is-expanded" onClick={openMailbox} aria-label={`查看${unreadMailIds.length}封新消息`}><span>✉</span><b>{unreadMailIds.length}</b></button>}
        {bubbleVisible && <div className={`pet-bubble ${expanded ? 'bubble-expanded' : 'device-bubble'}`} role="status"><button aria-label="关闭提醒" onClick={() => setBubbleVisible(false)}>×</button><strong>{appearance.petName || '布罗艾'}提醒</strong><span>{bubbleMessage ?? (fresh ? analysis?.message : '额度暂未更新，请打开真实额度页面查看状态。')}</span></div>}
        {dragging && <div className="drag-pill">移动中</div>}
      </section>
      {expanded && <aside className="usage-sidecar">
        <button className="history-open" onClick={openHistory}>使用历史与报告</button>
        {(page !== 'quota' || historyOpen) && <UsageSettings state={connection} desktop={!isBrowserFallback} onSelect={connection.select} onRefresh={() => void connection.refresh()} />}
        {connection.source === 'real' && <button className="auto-fishing-toggle" disabled={!fresh && !autoFishingEnabled} onClick={toggleAutoFishing}>{autoFishingEnabled ? '关闭自动钓鱼' : '开启自动钓鱼'}</button>}
        {connection.source === 'mock' && usage && fresh && <MockUsageControls usage={usage} onScenario={selectScenario} onPatch={patchUsage} onMockResetSignal={triggerMockResetSignal} resetWatchEnabled={resetWatchEnabled} resetWatchNextAt={resetWatchNextAt} resetCheckStatus={resetCheckStatus} onToggleResetWatch={toggleResetWatch} autoFishingEnabled={autoFishingEnabled} autoFishingNextAt={autoFishingNextAt} onToggleAutoFishing={toggleAutoFishing} onRunAutoFishing={runAutoFishingNow} onClearCodexHistory={clearCodexHistory} saveStatus={saveStatus} />}
      </aside>}
    </main>
  )
}
