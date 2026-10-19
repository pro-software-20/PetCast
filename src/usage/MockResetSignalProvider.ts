import type { ResetSignal } from '../types/notifications'
import type { ResetSignalProvider } from './ResetSignalProvider'

const resetSignal: Omit<ResetSignal, 'publishedAt'> = {
  id: 'x-status-2103911959544610829',
  type: 'resetSignal',
  author: 'Tibo',
  handle: '@thsottiaux',
  text: 'Tibo 发布了新的额度相关动态，可能与额度重置有关。',
  resetType: 'short',
  confidence: 'possible',
  sourceLabel: 'X · @thsottiaux',
  sourceUrl: 'https://x.com/thsottiaux/status/2103911959544610829',
}

export class MockResetSignalProvider implements ResetSignalProvider {
  async getLatestSignal(): Promise<ResetSignal> {
    return {
      ...resetSignal,
      publishedAt: new Date().toISOString(),
    }
  }
}
