import type { ProviderId } from '../types/taskOrchestration'

export type QuotaAvailability = 'available' | 'estimated' | 'unavailable'
export type QuotaSource = 'official-api' | 'local-record' | 'manual'
export type QuotaMetricUnit = 'percent' | 'tokens' | 'requests' | 'currency'

export interface QuotaMetric {
  id: string
  label: string
  unit: QuotaMetricUnit
  remaining?: number
  used?: number
  limit?: number
  currency?: string
  resetAt?: string
}

export interface ProviderQuotaSnapshot {
  providerId: ProviderId
  availability: QuotaAvailability
  source: QuotaSource
  metrics: QuotaMetric[]
  sampledAt: string
  message?: string
}

export interface QuotaProvider {
  readonly providerId: ProviderId
  /** Implementations return an unavailable snapshot instead of leaking provider errors. */
  getQuota(signal?: AbortSignal): Promise<ProviderQuotaSnapshot>
}
