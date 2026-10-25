import type { Ticket } from './types'

export interface ShortlistValues {
  fit_score: string
  complexity: string
  market: string
  applications_count: string
  budget_amount: string
  currency: string
  customer: string
}

export function shortlistValues(tk?: Ticket): ShortlistValues {
  return {
    fit_score: tk?.fit_score?.toString() ?? '',
    complexity: tk?.complexity?.toString() ?? '',
    market: tk?.market ?? '',
    applications_count: tk?.applications_count?.toString() ?? '',
    budget_amount: tk?.budget_amount ?? '',
    currency: tk?.currency ?? 'KZT',
    customer: tk?.customer ?? '',
  }
}

export function shortlistPayload(v: ShortlistValues) {
  return {
    fit_score: v.fit_score === '' ? null : Number(v.fit_score),
    complexity: v.complexity === '' ? null : Number(v.complexity),
    applications_count: v.applications_count === '' ? null : Number(v.applications_count),
    budget_amount: v.budget_amount.trim() || null,
    currency: v.currency.trim().toUpperCase(),
    market: v.market.trim(),
    customer: v.customer.trim(),
  }
}

/** Calendar week, Monday–Sunday; input must be today's date in the portal zone. */
export function calendarWeek(today: string): [string, string] {
  const d = new Date(today + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7)
  const from = d.toISOString().slice(0, 10)
  d.setUTCDate(d.getUTCDate() + 6)
  return [from, d.toISOString().slice(0, 10)]
}

export function submissionPending(status: string): boolean {
  return status !== 'sent' && status !== 'closed'
}
