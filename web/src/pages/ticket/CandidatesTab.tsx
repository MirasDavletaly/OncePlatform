import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2, UserSearch, X } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { formatDateTime } from '../../lib/format'
import { useSession } from '../../lib/session'
import type { CvLang, CvMeta, CvRole, Ticket, TicketCv } from '../../lib/types'
import { cn } from '../../lib/utils'
import { langLabel, levelLabel, profLabel, scoreTone, useCvMeta, WhyView } from '../../components/cv'
import { ViaBadge } from '../../components/badges'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, Loading, Modal, Select, Textarea, useToast } from '../../components/ui'

const TOP = 10
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

type Draft = Omit<CvRole, 'skills_must' | 'skills_nice' | 'certificates'> & { skills_must: string; skills_nice: string; certificates: string }

const toDraft = (r: CvRole): Draft => ({
  ...r,
  skills_must: (r.skills_must ?? []).join(', '),
  skills_nice: (r.skills_nice ?? []).join(', '),
  certificates: (r.certificates ?? []).join(', '),
  languages: r.languages ?? [],
})

const fromDraft = (d: Draft): CvRole => ({
  title: d.title,
  profession: d.profession || undefined,
  count: Number(d.count) || 1,
  min_years: Number(d.min_years) || 0,
  skills_must: list(d.skills_must),
  skills_nice: list(d.skills_nice),
  certificates: list(d.certificates),
  languages: d.languages,
  notes: d.notes,
})

function RolesEditor({ ticket, roles, meta, onClose }: { ticket: Ticket; roles: CvRole[]; meta?: CvMeta; onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [drafts, setDrafts] = useState<Draft[]>(() => (roles.length ? roles : [{ title: '' }]).map(toDraft))
  const set = (i: number, patch: Partial<Draft>) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)))
  const save = useMutation({
    mutationFn: () => api.put(`/tickets/${ticket.number}/cv/requirements`, { roles: drafts.filter((d) => d.title.trim()).map(fromDraft) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ticket-cv', ticket.number] })
      void qc.invalidateQueries({ queryKey: ['history', ticket.number] })
      toast(t.cv.req.saved)
      onClose()
    },
  })
  const langs = meta?.languages ?? Object.keys(t.cv.lang)
  const levels = meta?.levels ?? []
  return (
    <Modal
      open
      onClose={onClose}
      title={`${t.cv.req.title} · ${ticket.number}`}
      full
      footer={
        <>
          {save.error && <p className="mr-auto self-center text-[13px] text-danger">{errorMessage(save.error)}</p>}
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {drafts.map((d, i) => (
          <div key={i} className="rounded-xl border border-line p-4">
            <div className="mb-3 flex items-start gap-2">
              <Field label={t.cv.req.role} className="flex-1">
                <Input value={d.title} maxLength={200} onChange={(e) => set(i, { title: e.target.value })} />
              </Field>
              <IconButton label={t.cv.remove} className="mt-6" onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_100px_120px]">
              <Field label={t.cv.req.profession}>
                <Select value={d.profession ?? ''} onChange={(e) => set(i, { profession: e.target.value })}>
                  <option value="">{t.cv.req.professionNone}</option>
                  {meta?.professions.map((p) => (
                    <option key={p.id} value={p.id}>{profLabel(meta, p.id)}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t.cv.req.count}>
                <Input type="number" min={1} max={100} value={d.count ?? 1} onChange={(e) => set(i, { count: Number(e.target.value) })} />
              </Field>
              <Field label={t.cv.req.minYears}>
                <Input type="number" min={0} max={50} step={0.5} value={d.min_years ?? 0} onChange={(e) => set(i, { min_years: Number(e.target.value) })} />
              </Field>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label={t.cv.req.skillsMust} hint={t.cv.req.listHint}>
                <Input value={d.skills_must} onChange={(e) => set(i, { skills_must: e.target.value })} />
              </Field>
              <Field label={t.cv.req.skillsNice} hint={t.cv.req.listHint}>
                <Input value={d.skills_nice} onChange={(e) => set(i, { skills_nice: e.target.value })} />
              </Field>
              <Field label={t.cv.req.certificates} hint={t.cv.req.listHint}>
                <Input value={d.certificates} onChange={(e) => set(i, { certificates: e.target.value })} />
              </Field>
              <Field label={t.cv.req.languages}>
                <div className="flex flex-col gap-1.5">
                  {(d.languages ?? []).map((l, k) => {
                    const setLang = (patch: Partial<CvLang>) =>
                      set(i, { languages: d.languages!.map((x, j) => (j === k ? { ...x, ...patch } : x)) })
                    return (
                      <div key={k} className="flex gap-1.5">
                        <Select value={l.language} onChange={(e) => setLang({ language: e.target.value })} aria-label={t.cv.f.language}>
                          {langs.map((x) => <option key={x} value={x}>{langLabel(x)}</option>)}
                        </Select>
                        <Select value={l.level ?? ''} onChange={(e) => setLang({ level: e.target.value })} aria-label={t.cv.f.level}>
                          <option value="">{t.cv.anyLevel}</option>
                          {levels.map((x) => <option key={x} value={x}>{levelLabel(x)}</option>)}
                        </Select>
                        <IconButton label={t.cv.remove} onClick={() => set(i, { languages: d.languages!.filter((_, j) => j !== k) })}>
                          <X className="size-4" />
                        </IconButton>
                      </div>
                    )
                  })}
                  <div>
                    <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />}
                      onClick={() => set(i, { languages: [...(d.languages ?? []), { language: langs[0] }] })}>
                      {t.cv.addLanguage}
                    </Button>
                  </div>
                </div>
              </Field>
            </div>
            <Field label={t.cv.req.notes} className="mt-3">
              <Textarea rows={2} value={d.notes ?? ''} maxLength={2000} onChange={(e) => set(i, { notes: e.target.value })} />
            </Field>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setDrafts([...drafts, { title: '', skills_must: '', skills_nice: '', certificates: '', languages: [] }])}>
            {t.cv.req.add}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function RoleSummary({ role, meta }: { role: CvRole; meta?: CvMeta }) {
  const bits = [
    role.profession && profLabel(meta, role.profession),
    (role.min_years ?? 0) > 0 && fmt(t.cv.match.yearsOnly, { years: role.min_years! }) + '+',
    (role.count ?? 1) > 1 && fmt(t.cv.req.people, { n: role.count! }),
    ...(role.certificates ?? []),
    ...(role.languages ?? []).map((l) => `${langLabel(l.language)}${l.level ? ' ' + levelLabel(l.level) : ''}`),
  ].filter(Boolean)
  return (
    <div className="text-[13px] text-muted">
      {bits.join(' · ')}
      {(role.skills_must ?? []).length > 0 && <span className="block">{(role.skills_must ?? []).join(', ')}</span>}
      {role.notes && <span className="mt-1 block italic">{t.cv.req.notes}: {role.notes}</span>}
    </div>
  )
}

function RoleCard({ m, meta }: { m: TicketCv['matches'][number]; meta?: CvMeta }) {
  const [all, setAll] = useState(false)
  const rows = all ? m.results : m.results.slice(0, TOP)
  const eligible = m.results.filter((r) => r.fails.length === 0).length
  return (
    <Card className="overflow-hidden">
      <CardHeader title={m.role.title} hint={<RoleSummary role={m.role} meta={meta} />} />
      {m.results.length === 0 ? (
        <EmptyState text={t.cv.match.noResults} />
      ) : (
        <>
          <p className="border-b border-line px-5 py-2 text-[12px] text-muted">{fmt(t.cv.match.eligible, { n: eligible })}</p>
          <ol className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.candidate_id} className={cn('flex gap-4 px-5 py-3', r.fails.length > 0 && 'opacity-75')}>
                <Badge className={cn('num h-8 min-w-11 justify-center text-[14px]', scoreTone(r.score, r.fails.length > 0))}>{r.score}</Badge>
                <div className="min-w-0 flex-1">
                  <Link to={`/cv/${r.candidate_id}`} className="text-sm font-medium hover:text-accent">
                    {r.name || r.code}
                  </Link>
                  <span className="ml-2 text-[12px] text-muted">
                    {r.name && <span className="num mr-2">{r.code}</span>}
                    {r.label}
                  </span>
                  <div className="mt-1.5">
                    <WhyView row={r} role={m.role} />
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {m.results.length > TOP && (
            <div className="border-t border-line px-5 py-2">
              <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
                {all ? fmt(t.cv.match.showTop, { n: TOP }) : fmt(t.cv.match.showAll, { n: m.results.length })}
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  )
}

/** Key personnel of a tender and the CV database ranked for each role. */
export function CandidatesTab({ ticket }: { ticket: Ticket }) {
  const { can } = useSession()
  const meta = useCvMeta()
  const [editing, setEditing] = useState(false)
  const q = useQuery({ queryKey: ['ticket-cv', ticket.number], queryFn: () => api.get<TicketCv>(`/tickets/${ticket.number}/cv`) })
  if (q.isPending) return <Loading />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const { requirements: req, matches, candidates_total } = q.data
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold">{t.cv.req.title}</h2>
            <p className="mt-0.5 text-[13px] text-muted">{t.cv.req.hint}</p>
            {req.updated_at && (
              <p className="mt-1.5 flex items-center gap-2 text-[12px] text-muted">
                {fmt(t.cv.req.updated, { name: req.updated_by_name ?? '', date: formatDateTime(req.updated_at) })}
                {req.via && <ViaBadge via={req.via} />}
              </p>
            )}
          </div>
          {can('ticket.files') && (
            <Button size="sm" icon={req.roles.length ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />} onClick={() => setEditing(true)}>
              {req.roles.length ? t.cv.req.edit : t.cv.req.add}
            </Button>
          )}
        </div>
        {req.roles.length === 0 && (
          <EmptyState icon={<UserSearch className="size-8" />} text={fmt(t.cv.req.empty, { number: ticket.number })} />
        )}
        {req.roles.length > 0 && candidates_total === 0 && <p className="mt-3 text-[13px] text-muted">{t.cv.match.emptyDb}</p>}
      </Card>
      {candidates_total > 0 && matches.map((m, i) => <RoleCard key={i} m={m} meta={meta.data} />)}
      {editing && <RolesEditor ticket={ticket} roles={req.roles} meta={meta.data} onClose={() => setEditing(false)} />}
    </div>
  )
}
