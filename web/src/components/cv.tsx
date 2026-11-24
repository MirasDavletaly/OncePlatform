import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BadgeCheck, Check, X } from 'lucide-react'
import { fmt, language, t } from '../i18n'
import { api } from '../lib/api'
import type { Candidate, CvMatchRow, CvMeta, CvPlace, CvProfile, CvRole } from '../lib/types'
import { cn } from '../lib/utils'
import { Badge } from './ui'

// Shared pieces of the CV section: engine dictionary, labels, profile view and match reasons.

export function useCvMeta() {
  return useQuery({ queryKey: ['cv-meta'], queryFn: () => api.get<CvMeta>('/cv/meta'), staleTime: Infinity })
}

export function profLabel(meta: CvMeta | undefined, id?: string | null): string {
  if (!id) return ''
  const p = meta?.professions.find((x) => x.id === id)
  return p ? (language === 'ru' ? p.ru : p.en) : id
}

const pick = (x: { en: string; ru: string }) => (language === 'ru' ? x.ru : x.en)

export function countryLabel(meta: CvMeta | undefined, code?: string | null): string {
  if (!code) return ''
  const c = meta?.countries.find((x) => x.code === code)
  return c ? pick(c) : code
}

/** City id of the dictionary, or a city typed by hand (shown as is). */
export function cityLabel(meta: CvMeta | undefined, city?: string | null): string {
  if (!city) return ''
  const c = meta?.cities.find((x) => x.id === city)
  return c ? pick(c) : city
}

export function placeLabel(meta: CvMeta | undefined, place?: CvPlace | null): string {
  if (!place) return ''
  return [cityLabel(meta, place.city), countryLabel(meta, place.country)].filter(Boolean).join(', ')
}

export const degreeLabel = (d?: string | null) => (d ? (t.cv.degree[d] ?? d) : '')

/** A suggested position: a profession of the taxonomy or a job title the candidate held. */
export function positionLabel(meta: CvMeta | undefined, x: { prof?: string; title?: string }): string {
  return x.prof ? profLabel(meta, x.prof) : (x.title ?? '')
}

export const DEGREE_ORDER = ['secondary', 'college', 'higher', 'bachelor', 'specialist', 'master', 'mba', 'phd']

/**
 * The profile in the interface language: Claude's translation of its texts (keys like "work.0.position") written over
 * the original. Without an up-to-date translation into this language the profile stays as parsed.
 */
export function localProfile(c: Pick<Candidate, 'profile' | 'translations'>): CvProfile | null {
  const texts = c.translations?.[language]
  if (!c.profile || !texts) return c.profile
  const p = structuredClone(c.profile) as unknown as Record<string, unknown>
  for (const [path, value] of Object.entries(texts)) {
    const parts = path.split('.')
    let node: unknown = p
    for (const part of parts.slice(0, -1)) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined
    const leaf = parts[parts.length - 1]
    if (node && typeof node === 'object' && typeof (node as Record<string, unknown>)[leaf] === 'string') (node as Record<string, unknown>)[leaf] = value
  }
  return p as unknown as CvProfile
}

/** The highest education level found in the profile, with its institution. */
export function topEducation(p: CvProfile): { degree: string | null; institution: string } | null {
  if (p.education.length === 0) return null
  const best = [...p.education].sort((a, b) => DEGREE_ORDER.indexOf(b.degree ?? '') - DEGREE_ORDER.indexOf(a.degree ?? ''))[0]
  return { degree: best.degree ?? null, institution: best.institution }
}

/** Any language the parser knows (ar, hi, ta…): our names first, then the browser's own. */
export function langLabel(code: string): string {
  if (t.cv.lang[code]) return t.cv.lang[code]
  try {
    const name = new Intl.DisplayNames([language], { type: 'language' }).of(code)
    if (name && name !== code) return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    // not a language code
  }
  return code
}

/** A real language code (the parser marks CVs in several languages as "mix"). */
export const isLangCode = (code?: string | null): code is string => !!code && /^[a-z]{2,3}$/.test(code) && code !== 'mix'
export const levelLabel = (level?: string | null) => (level ? (t.cv.level[level] ?? level) : '')

/** "2021-03" → "03.2021" */
export function ym(s?: string | null): string {
  if (!s) return ''
  const m = /^(\d{4})-(\d{2})$/.exec(s)
  return m ? `${m[2]}.${m[1]}` : s
}

export function period(start?: string | null, end?: string | null): string {
  return `${ym(start) || '?'} – ${end ? ym(end) : t.cv.present}`
}

export function years(n?: number | null): string {
  return fmt(t.cv.years, { n: n ?? 0 })
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="break-inside-avoid">
      <h3 className="mb-2 border-b border-line pb-1.5 text-[13px] font-semibold tracking-wide text-accent uppercase print:text-black">
        {title}
      </h3>
      {children}
    </section>
  )
}

const empty = <p className="text-[13px] text-muted">{t.cv.nothingFound}</p>

/** Mark of an entry confirmed by an attached diploma or certificate. */
function Verified({ doc }: { doc?: string }) {
  if (!doc) return null
  return (
    <span title={t.cv.docs.verified} className="ml-1.5 inline-flex align-[-2px] text-ok">
      <BadgeCheck className="size-4" aria-label={t.cv.docs.verified} />
    </span>
  )
}

/** Read-only profile: positions, countries, experience, projects, education, skills, languages, certificates. */
export function ProfileView({ profile, meta }: { profile: CvProfile; meta?: CvMeta }) {
  const positions = profile.meta.positions ?? []
  const countries = profile.meta.countries ?? []
  const projects = profile.projects ?? []
  return (
    <div className="flex flex-col gap-6">
      {profile.basics.summary && (
        <Section title={t.cv.summary}>
          <p className="text-sm leading-relaxed">{profile.basics.summary}</p>
        </Section>
      )}
      {(positions.length > 0 || countries.length > 0) && (
        <div className="grid gap-6 sm:grid-cols-2">
          {positions.length > 0 && (
            // suggestions for the team, not part of a CV sent with a bid
            <div className="print:hidden">
              <Section title={t.cv.positions}>
                <ul className="flex flex-col gap-1.5 text-sm">
                  {positions.map((x) => (
                    <li key={x.prof ?? x.title}>
                      <span className="font-medium">{positionLabel(meta, x)}</span>
                      <span className="text-muted">
                        {' '}· {t.cv.seniority[x.level]} · {fmt(t.cv.positionYears, { years: x.years })}
                        {x.skillMatch !== undefined && ` · ${fmt(t.cv.skillMatch, { n: Math.round(x.skillMatch * 100) })}`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[12px] text-muted">{t.cv.positionsHint}</p>
              </Section>
            </div>
          )}
          {countries.length > 0 && (
            <Section title={t.cv.countries}>
              <ul className="flex flex-col gap-1 text-sm">
                {countries.map((c) => (
                  <li key={c.country}>
                    {countryLabel(meta, c.country)} <span className="num text-muted">— {years(c.years)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
      <Section title={t.cv.experience}>
        {profile.work.length === 0 ? (
          empty
        ) : (
          <ol className="flex flex-col gap-4">
            {profile.work.map((w, i) => (
              <li key={i} className="grid gap-1 sm:grid-cols-[150px_1fr] sm:gap-4">
                <span className="num text-[13px] text-muted">{period(w.startDate, w.endDate)}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{w.position || '—'}</p>
                  <p className="text-[13px] text-muted">
                    {[w.name, placeLabel(meta, w.location)].filter(Boolean).join(' · ')}
                    {w.location?.inferred && (
                      <span title={t.cv.inferredPlace} className="cursor-help print:hidden"> ≈</span>
                    )}
                  </p>
                  {w.prof && (
                    <p className="mt-0.5 text-[12px] text-muted print:hidden">
                      {profLabel(meta, w.prof)}
                      {w.approx && ` · ${t.cv.approx}`}
                    </p>
                  )}
                  {w.summary && <p className="mt-1 text-[13px] leading-relaxed">{w.summary}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
      {projects.length > 0 && (
        <Section title={t.cv.projects}>
          <ol className="flex flex-col gap-4">
            {projects.map((x, i) => (
              <li key={i} className="grid gap-1 sm:grid-cols-[150px_1fr] sm:gap-4">
                <span className="num text-[13px] text-muted">{x.startDate || x.endDate ? period(x.startDate, x.endDate) : ''}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{x.name}</p>
                  {(x.role || x.customer) && (
                    <p className="text-[13px] text-muted">
                      {[x.role && `${t.cv.projectRole}: ${x.role}`, x.customer && `${t.cv.projectCustomer}: ${x.customer}`].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {x.summary && <p className="mt-1 text-[13px] leading-relaxed">{x.summary}</p>}
                </div>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title={t.cv.education}>
        {profile.education.length === 0 ? (
          empty
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {profile.education.map((e, i) => (
              <li key={i}>
                <span className="num mr-2 font-semibold">{e.endDate}</span>
                {/* without the institution ("Высшее", 2012) the level leads */}
                {e.institution || <span className="first-letter:uppercase">{degreeLabel(e.degree)}</span>}
                {e.area && <span className="text-muted">, {e.area}</span>}
                {e.degree && e.institution && <span className="text-muted"> ({degreeLabel(e.degree)})</span>}
                <Verified doc={e.doc} />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title={t.cv.skills}>
        {profile.skills.length === 0 ? (
          empty
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {profile.skills.map((s) => (
              <Badge key={s.name} className="bg-surface-2 text-ink print:border print:border-line">
                {s.name}
              </Badge>
            ))}
          </div>
        )}
      </Section>
      <div className="grid gap-6 sm:grid-cols-2">
        <Section title={t.cv.languages}>
          {profile.languages.length === 0 ? (
            empty
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {profile.languages.map((l, i) => (
                <li key={i}>
                  {langLabel(l.language)}
                  {l.fluency && <span className="text-muted"> — {levelLabel(l.fluency)}</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title={t.cv.certificates}>
          {profile.certificates.length === 0 ? (
            empty
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {profile.certificates.map((c, i) => (
                <li key={i}>
                  {c.name}
                  {c.issuer && !c.name.includes(c.issuer) && <span className="text-muted"> — {c.issuer}</span>}
                  {c.date && <span className="num text-muted"> ({c.date})</span>}
                  <Verified doc={c.doc} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

export function scoreTone(score: number, failed: boolean): string {
  if (failed) return 'bg-surface-2 text-muted'
  if (score >= 75) return 'bg-ok-soft text-ok'
  if (score >= 50) return 'bg-gold-soft text-gold'
  return 'bg-surface-2 text-ink'
}

function Chip({ ok, children, soft }: { ok: boolean; children: ReactNode; soft?: boolean }) {
  return (
    <Badge
      className={cn(
        ok ? 'bg-ok-soft text-ok' : soft ? 'bg-surface-2 text-muted' : 'bg-danger-soft text-danger',
        !ok && 'line-through decoration-1',
      )}
    >
      {ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
      {children}
    </Badge>
  )
}

function titleKey(v: number): string {
  return v >= 1 ? '1' : v >= 0.25 ? '0.5' : '0'
}

/** Why a candidate got its score for a role: experience, title, skills, certificates, languages. */
export function WhyView({ row, role }: { row: CvMatchRow; role: CvRole }) {
  const w = row.why
  const expFail = row.fails.includes('exp')
  const showExp = (role.min_years ?? 0) > 0 || !!role.profession
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      {(showExp || w.titleMatch !== null) && (
        <p className="text-muted">
          {showExp && (
            <span className={cn(expFail && 'font-medium text-danger')}>
              {(role.min_years ?? 0) > 0
                ? fmt(t.cv.match.years, { years: w.years, min: w.minYears })
                : fmt(t.cv.match.yearsOnly, { years: w.years })}
              {role.profession && ` ${t.cv.match.inProfession}`}
            </span>
          )}
          {w.titleMatch !== null && (
            <>
              {showExp && ' · '}
              {t.cv.match.title[titleKey(w.titleMatch)]}
            </>
          )}
        </p>
      )}
      {(w.mustMet.length > 0 || w.mustMissing.length > 0 || w.niceMet.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {w.mustMet.map((s) => <Chip key={'m' + s} ok>{s}</Chip>)}
          {w.mustMissing.map((s) => <Chip key={'x' + s} ok={false}>{s}</Chip>)}
          {w.niceMet.map((s) => <Chip key={'n' + s} ok>{s}</Chip>)}
          {w.niceMissing.map((s) => <Chip key={'y' + s} ok={false} soft>{s}</Chip>)}
        </div>
      )}
      {(w.certMet.length > 0 || w.certMissing.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {w.certMet.map((s) => <Chip key={'c' + s} ok>{s}</Chip>)}
          {w.certMissing.map((s) => <Chip key={'d' + s} ok={false}>{s}</Chip>)}
        </div>
      )}
      {w.languages.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {w.languages.map((l) => (
            <Chip key={l.language} ok={l.ok} soft={!l.have}>
              {langLabel(l.language)}
              {l.need && ` ${levelLabel(l.need)}`}:{' '}
              {l.inferred ? t.cv.match.inferred : l.have ? levelLabel(l.have) : l.listed ? t.cv.match.noLevel : t.cv.match.notListed}
            </Chip>
          ))}
        </div>
      )}
      {row.fails.length > 0 && (
        <p className="text-[12px] font-medium text-danger">{row.fails.map((f) => t.cv.match.fails[f] ?? f).join(' · ')}</p>
      )}
    </div>
  )
}
