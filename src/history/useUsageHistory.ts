import { useEffect, useMemo, useState } from 'react'
import type { UsageReading } from '../usage/UsageReader'
import { createUsageHistoryStore, type HistoryBridge } from './UsageHistoryStore'
import { UsageHistoryRecorder } from './UsageHistoryRecorder'
export function useUsageHistory(reading: UsageReading | null, bridge: HistoryBridge | undefined) {
  const store = useMemo(() => createUsageHistoryStore(bridge), [bridge])
  const recorder = useMemo(() => new UsageHistoryRecorder(store), [store])
  const [revision, setRevision] = useState(0)
  const [recordingState, setRecordingState] = useState<'waiting' | 'saved' | 'error'>('waiting')
  const status = recordingState === 'saved' ? '历史记录正常 · 约每 3 分钟保存' : recordingState === 'error' ? '历史保存失败，请检查数据文件或权限；下次有效读取会重试' : '等待有效额度记录'
  useEffect(() => {
    let active = true
    if (reading?.status !== 'fresh') { setRecordingState('waiting'); return }
    void recorder.record(reading).then(saved => {
      if (active) { setRecordingState('saved'); if (saved) setRevision(v => v + 1) }
    }).catch(() => { if (active) setRecordingState('error') })
    return () => { active = false }
  }, [recorder, reading])
  return {store, recorder, revision, status, recordingState}
}
