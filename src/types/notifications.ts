import type { FishSpecies } from './fishing'

export interface ResetSignal {
  id: string
  type: 'resetSignal'
  author: string
  handle: string
  text: string
  publishedAt: string
  resetType: 'short' | 'weekly'
  confidence: 'possible' | 'likely'
  sourceLabel: string
  sourceUrl: string
}

export interface AutoFishingReport {
  id: string
  type: 'autoFishing'
  createdAt: string
  fish: Array<{
    speciesId: FishSpecies['id']
    name: string
    length: number
  }>
  newSpeciesIds: FishSpecies['id'][]
}

export interface ResetCompletedNotice {
  id: string
  type: 'resetCompleted'
  source?: 'real' | 'mock'
  createdAt: string
  resetType: 'short' | 'weekly'
}

export type MailItem = ResetSignal | ResetCompletedNotice | AutoFishingReport
