import type { ResetSignal } from '../types/notifications'

export interface ResetSignalProvider {
  getLatestSignal(): Promise<ResetSignal>
}

