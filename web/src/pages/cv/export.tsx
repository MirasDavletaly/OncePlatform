import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileDown, Pencil } from 'lucide-react'
import { fmt, t } from '../../i18n'
import { api, errorMessage } from '../../lib/api'
import { useSession } from '../../lib/session'
import type { Letterhead } from '../../lib/types'
import { Button, Field, IconButton, Modal, Select, Textarea, buttonClass, useToast } from '../../components/ui'

// The choice of letterhead is the viewer's own and is remembered in this browser only.
const KEY = 'cv.letterhead'
const stored = () => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/** Word export of the standard CV: on the letterhead of a company or without one, in English or Russian. */
export function CvExport({ id }: { id: string }) {
  const { can } = useSession()
  const q = useQuery({ queryKey: ['cv-letterheads'], queryFn: () => api.get<{ items: Letterhead[] }>('/cv/letterheads') })
  const [choice, setChoice] = useState<string | null>(stored)
  const [editing, setEditing] = useState(false)
  const items = q.data?.items ?? []
  const lh = choice ?? items[0]?.id ?? ''
  const pick = (v: string) => {
    setChoice(v)
    try {
      localStorage.setItem(KEY, v)
    } catch {
      /* private window: the choice lasts until the page is left */
    }
  }
  const href = (lang: string) => `/api/v1/cv/candidates/${id}/export.docx?lang=${lang}${lh ? `&letterhead=${encodeURIComponent(lh)}` : ''}`
  return (
    <>
      <Select aria-label={t.cv.letterhead} title={t.cv.letterhead} className="py-0 text-[13px]" style={{ width: 'auto', height: '2rem' }} value={lh} onChange={(e) => pick(e.target.value)}>
        {items.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
        <option value="">{t.cv.noLetterhead}</option>
      </Select>
      {['en', 'ru'].map((lang) => (
        <a key={lang} className={buttonClass('secondary', 'sm')} href={href(lang)}>
          <FileDown className="size-3.5" /> {fmt(t.cv.exportDocx, { lang: lang.toUpperCase() })}
        </a>
      ))}
      {can('admin.users') && (
        <IconButton label={t.cv.editLetterheads} className="size-8" onClick={() => setEditing(true)}>
          <Pencil className="size-3.5" />
        </IconButton>
      )}
      {editing && <LetterheadsModal items={items} first={lh || items[0]?.id} onClose={() => setEditing(false)} />}
    </>
  )
}

function LetterheadsModal({ items, first, onClose }: { items: Letterhead[]; first?: string; onClose: () => void }) {
  const toast = useToast()
  const qc = useQueryClient()
  const [id, setId] = useState(first ?? '')
  const [drafts, setDrafts] = useState<Record<string, { header: string; footer: string }>>(() =>
    Object.fromEntries(items.map((l) => [l.id, { header: l.header, footer: l.footer }])),
  )
  const cur = drafts[id]
  const save = useMutation({
    mutationFn: () => api.put<Letterhead>(`/cv/letterheads/${id}`, cur),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cv-letterheads'] })
      toast(t.cv.letterheadSaved)
    },
    onError: (e) => toast(errorMessage(e), 'error'),
  })
  const set = (patch: Partial<{ header: string; footer: string }>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }))
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t.cv.editLetterheads}
      footer={
        <>
          <Button onClick={onClose}>{t.common.close}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!cur} onClick={() => save.mutate()}>
            {t.common.save}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select aria-label={t.cv.letterhead} value={id} onChange={(e) => setId(e.target.value)}>
          {items.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </Select>
        {cur && (
          <>
            <Field label={t.cv.letterheadHeader} hint={t.cv.letterheadHint}>
              <Textarea rows={5} value={cur.header} onChange={(e) => set({ header: e.target.value })} />
            </Field>
            <Field label={t.cv.letterheadFooter} hint={t.cv.letterheadFooterHint}>
              <Textarea rows={4} value={cur.footer} onChange={(e) => set({ footer: e.target.value })} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
