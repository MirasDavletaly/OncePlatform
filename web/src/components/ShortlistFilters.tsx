import { useState } from 'react'
import { t } from '../i18n'
import { Button, Field, Input, Select } from './ui'

export const SHORTLIST_FILTERS = ['fit_min', 'fit_max', 'complexity_min', 'complexity_max', 'applications_min', 'applications_max',
  'budget_min', 'budget_max', 'currency', 'market', 'customer', 'source_url', 'loss_reason'] as const

export function ShortlistFilters({ params, apply }: { params: URLSearchParams; apply: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(SHORTLIST_FILTERS.map((k) => [k, params.get(k) ?? ''])))
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }))
  return (
    <form className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2 xl:col-span-4 md:col-span-2 xl:grid-cols-4"
      onSubmit={(e) => { e.preventDefault(); apply(values) }}>
      {(['fit', 'complexity', 'applications', 'budget'] as const).map((key) => {
        const label = t.shortlist[{ fit: 'fit_score', complexity: 'complexity', applications: 'applications_count', budget: 'budget_amount' }[key] as 'fit_score' | 'complexity' | 'applications_count' | 'budget_amount']
        const score = key === 'fit' || key === 'complexity'
        return <fieldset key={key}>
          <legend className="mb-1.5 text-[12px] font-medium text-muted">{label}</legend>
          <div className="flex gap-2">
            {(['min', 'max'] as const).map((bound) => <Input key={bound} aria-label={`${label}: ${t.shortlist[bound === 'min' ? 'minimum' : 'maximum']}`}
              placeholder={t.shortlist[bound === 'min' ? 'minimum' : 'maximum']} value={values[key + '_' + bound]}
              type={key === 'budget' ? 'text' : 'number'} inputMode={key === 'budget' ? 'decimal' : 'numeric'}
              min={score ? 1 : 0} max={score ? 5 : 2147483647} step={1}
              pattern={key === 'budget' ? '(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?' : undefined}
              onChange={(e) => set(key + '_' + bound, e.target.value)} />)}
          </div>
        </fieldset>
      })}
      <Field label={t.shortlist.currency} htmlFor="filter-currency" hint={t.shortlist.amountHint}>
        <Input id="filter-currency" placeholder="KZT / USD" maxLength={3} pattern="[A-Za-z]{3}"
          required={!!values.budget_min || !!values.budget_max || params.get('sort') === 'budget_amount'}
          value={values.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
      </Field>
      {(['market', 'customer'] as const).map((key) => <Field key={key} label={t.shortlist[key]} htmlFor={'filter-' + key}>
        <Input id={'filter-' + key} maxLength={key === 'market' ? 120 : 300} value={values[key]} onChange={(e) => set(key, e.target.value)} />
      </Field>)}
      <Field label={t.shortlist.lossReason} htmlFor="filter-loss-reason">
        <Select id="filter-loss-reason" value={values.loss_reason} onChange={(e) => set('loss_reason', e.target.value)}>
          <option value="">{t.common.all}</option>
          {Object.entries(t.lossReasons).filter(([key]) => key !== 'unknown').map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </Select>
      </Field>
      <Field label={t.ticket.sourceUrl} htmlFor="filter-source">
        <Input id="filter-source" value={values.source_url} onChange={(e) => set('source_url', e.target.value)} />
      </Field>
      <div className="flex items-end"><Button type="submit" variant="primary">{t.common.search}</Button></div>
    </form>
  )
}
