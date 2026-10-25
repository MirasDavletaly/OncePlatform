import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortlistValues, shortlistPayload, calendarWeek, submissionPending } from '../src/lib/shortlist.ts'

test('form preserves unknown, zero and decimal precision on save and clear', () => {
  const values = shortlistValues({ fit_score: 5, complexity: 1, applications_count: 0, budget_amount: '9007199254740992.01', currency: 'USD' })
  assert.equal(values.applications_count, '0')
  const payload = shortlistPayload(values)
  assert.equal(payload.applications_count, 0)
  assert.equal(payload.budget_amount, '9007199254740992.01')
  assert.equal(payload.fit_score, 5)
  assert.equal(shortlistPayload({ ...values, fit_score: '', applications_count: '', budget_amount: '' }).applications_count, null)
  assert.equal(shortlistPayload({ ...values, budget_amount: '' }).budget_amount, null)
  assert.equal(shortlistPayload(shortlistValues()).fit_score, null)
})

test('calendar week is Monday through Sunday including year boundaries', () => {
  assert.deepEqual(calendarWeek('2026-10-22'), ['2026-10-19', '2026-10-25'])
  assert.deepEqual(calendarWeek('2026-10-25'), ['2026-10-19', '2026-10-25'])
  assert.deepEqual(calendarWeek('2027-01-01'), ['2026-12-28', '2027-01-03'])
})

test('only tasks awaiting submission can have deadline urgency', () => {
  for (const status of ['new', 'analysis', 'solution']) assert.equal(submissionPending(status), true)
  for (const status of ['sent', 'closed']) assert.equal(submissionPending(status), false)
})
