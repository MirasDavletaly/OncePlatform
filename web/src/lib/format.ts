import { fmt, plural, t } from '../i18n'

// All dates are displayed in the portal time zone (APP_TIMEZONE, by default
// Asia/Almaty), regardless of the browser's own zone.
let tz = 'Asia/Almaty'

export function setTimezone(zone: string) {
  tz = zone
}

export function timezone() {
  return tz
}

type Parts = { year: string; month: string; day: string; hour: string; minute: string; weekday: string }

const partsCache = new Map<string, Intl.DateTimeFormat>()

function partsOf(d: Date): Parts {
  const key = tz + '|' + t.locale
  let f = partsCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(t.locale, {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
    partsCache.set(key, f)
  }
  const out: Record<string, string> = {}
  for (const p of f.formatToParts(d)) out[p.type] = p.value
  return out as unknown as Parts
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v)
}

/** dd.mm.yyyy */
export function formatDate(v: string | Date | null | undefined): string {
  if (!v) return ''
  const p = partsOf(toDate(v))
  return `${p.day}.${p.month}.${p.year}`
}

/** dd.mm.yyyy HH:MM */
export function formatDateTime(v: string | Date | null | undefined): string {
  if (!v) return ''
  const p = partsOf(toDate(v))
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`
}

/** HH:MM */
export function formatTime(v: string | Date): string {
  const p = partsOf(toDate(v))
  return `${p.hour}:${p.minute}`
}

/** Short weekday in the interface language, e.g. "Mon". */
export function weekday(v: Date): string {
  return partsOf(v).weekday.replace('.', '')
}

/** YYYY-MM-DD key of the calendar day in the portal zone. */
export function dayKey(v: string | Date): string {
  const p = partsOf(toDate(v))
  return `${p.year}-${p.month}-${p.day}`
}

/** Value for <input type="datetime-local"> in the portal zone. */
export function toLocalInput(v: string | null | undefined): string {
  if (!v) return ''
  const p = partsOf(toDate(v))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** Relative description like "today", "in 2 days", "overdue by 3 days". */
export function relativeDays(v: string): { label: string; days: number; overdue: boolean } {
  const ms = toDate(v).getTime() - Date.now()
  const today = dayKey(new Date())
  const target = dayKey(v)
  const dayDiff = Math.round((Date.parse(target + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000)
  if (ms < 0) {
    const hours = Math.floor(-ms / 3600000)
    const label =
      hours < 24
        ? fmt(t.deadline.overdue, { n: `${hours} ${plural(hours, t.deadline.hours)}` })
        : fmt(t.deadline.overdue, { n: `${-dayDiff} ${plural(-dayDiff, t.deadline.days)}` })
    return { label, days: dayDiff, overdue: true }
  }
  if (dayDiff === 0) return { label: t.deadline.today + ', ' + formatTime(v), days: 0, overdue: false }
  if (dayDiff === 1) return { label: t.deadline.tomorrow + ', ' + formatTime(v), days: 1, overdue: false }
  return { label: fmt(t.deadline.in, { n: `${dayDiff} ${plural(dayDiff, t.deadline.days)}` }), days: dayDiff, overdue: false }
}

/** Deadline urgency: overdue, < 3 days (red), < 7 days (gold) or calm. */
export function urgency(deadline: string | null, closed = false): 'overdue' | 'red' | 'gold' | 'calm' | 'none' {
  if (!deadline || closed) return 'none'
  const ms = toDate(deadline).getTime() - Date.now()
  if (ms < 0) return 'overdue'
  if (ms < 3 * 86400000) return 'red'
  if (ms < 7 * 86400000) return 'gold'
  return 'calm'
}

const sizeUnits = () => (t.locale.startsWith('ru') ? ['Б', 'КБ', 'МБ'] : ['B', 'KB', 'MB'])

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(t.locale, { maximumFractionDigits: 2 }).format(n)
}

export function formatSize(bytes: number): string {
  const [b, kb, mb] = sizeUnits()
  if (bytes < 1024) return `${bytes} ${b}`
  if (bytes < 1024 * 1024) return `${formatNumber(Math.round(bytes / 102.4) / 10)} ${kb}`
  return `${formatNumber(Math.round(bytes / 104857.6) / 10)} ${mb}`
}

/** "5 min ago" style for the activity feed; older items show the date. */
export function timeAgo(v: string): string {
  const diff = (Date.now() - toDate(v).getTime()) / 1000
  if (diff < 60) return t.time.justNow
  if (diff < 3600) return fmt(t.time.minAgo, { n: Math.floor(diff / 60) })
  if (diff < 86400 && dayKey(v) === dayKey(new Date())) return fmt(t.time.today, { time: formatTime(v) })
  if (diff < 2 * 86400) return fmt(t.time.yesterday, { time: formatTime(v) })
  return formatDateTime(v)
}
