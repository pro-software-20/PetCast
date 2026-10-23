export type LocalDayPeriod = 'day' | 'evening' | 'night'
export function getLocalDayCycle(now = new Date()): { period: LocalDayPeriod; label: string } {
  const hour = now.getHours()
  if (hour >= 6 && hour < 17) return { period: 'day', label: '白天' }
  if (hour >= 17 && hour < 19) return { period: 'evening', label: '傍晚' }
  return { period: 'night', label: '黑夜' }
}
