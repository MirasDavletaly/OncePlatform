import { t } from '../i18n'
import type { Ticket } from '../lib/types'
import type { ShortlistValues } from '../lib/shortlist'
import { Field, Input, Select } from './ui'

export function ShortlistFields({ value, set }: {
  value: ShortlistValues
  set: (key: keyof ShortlistValues, value: string) => void
}) {
  return (
    <fieldset className="grid gap-4 rounded-lg border border-line p-4 sm:grid-cols-2">
      <legend className="px-1 text-sm font-medium">{t.shortlist.title}</legend>
      {(['fit_score', 'complexity'] as const).map((key) => (
        <Field key={key} label={t.shortlist[key]} htmlFor={'f-' + key} hint={t.shortlist[key === 'fit_score' ? 'fitHint' : 'complexityHint']}>
          <Select id={'f-' + key} value={value[key]} onChange={(e) => set(key, e.target.value)}>
            <option value="">{t.shortlist.unknown}</option>
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </Field>
      ))}
      <Field label={t.shortlist.applications_count} htmlFor="f-applications">
        <Input id="f-applications" type="number" min={0} max={2147483647} step={1} placeholder={t.shortlist.unknown}
          value={value.applications_count} onChange={(e) => set('applications_count', e.target.value)} />
      </Field>
      <Field label={t.shortlist.market} htmlFor="f-market">
        <Input id="f-market" maxLength={120} value={value.market} onChange={(e) => set('market', e.target.value)} />
      </Field>
      <Field label={t.shortlist.budget_amount} htmlFor="f-budget">
        <Input id="f-budget" inputMode="decimal" pattern="(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?" placeholder="150000.00"
          value={value.budget_amount} onChange={(e) => set('budget_amount', e.target.value)} />
      </Field>
      <Field label={t.shortlist.currency} htmlFor="f-currency">
        <Input id="f-currency" required pattern="[A-Za-z]{3}" maxLength={3} value={value.currency}
          onChange={(e) => set('currency', e.target.value.toUpperCase())} />
      </Field>
      <Field label={t.shortlist.customer} htmlFor="f-customer">
        <Input id="f-customer" maxLength={300} value={value.customer} onChange={(e) => set('customer', e.target.value)} />
      </Field>
    </fieldset>
  )
}

export const SHORTLIST_COLUMNS = ['fit_score', 'complexity', 'market', 'applications_count', 'budget_amount', 'customer'] as const

export function shortlistDisplay(tk: Ticket, key: typeof SHORTLIST_COLUMNS[number]): string {
  const v = tk[key]
  if (v === null || v === undefined || v === '') return '—'
  return key === 'budget_amount' ? `${v} ${tk.currency}` : String(v)
}

export function ShortlistSummary({ ticket, full = false }: { ticket: Ticket; full?: boolean }) {
  const fields = full ? SHORTLIST_COLUMNS : SHORTLIST_COLUMNS.filter((key) => ticket[key] !== null && ticket[key] !== undefined && ticket[key] !== '')
  return (
    <dl className={full ? 'grid gap-2 text-sm' : 'mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted'}>
      {fields.map((key) => <div key={key} className={full ? 'flex justify-between gap-3' : 'flex gap-1'}>
        <dt className="text-muted">{t.shortlist[key]}:</dt><dd className="break-words text-right">{shortlistDisplay(ticket, key)}</dd>
      </div>)}
    </dl>
  )
}
