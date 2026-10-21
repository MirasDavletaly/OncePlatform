import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Bold,
  Code,
  Columns2,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  PencilLine,
  Quote,
  Table,
} from 'lucide-react'
import { t } from '../i18n'
import { cn } from '../lib/utils'

/** Renders Markdown safely (raw HTML is not rendered). Links open in a new tab. */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('md prose prose-sm max-w-none', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

type Mode = 'write' | 'preview' | 'split'

/**
 * Markdown editor: textarea with a formatting toolbar and live preview
 * (side by side on wide screens). Drafts live only in component state.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSave,
  placeholder,
  minRows = 12,
  autoFocus,
  toolbarExtra,
  id,
}: {
  value: string
  onChange: (v: string) => void
  onSave?: () => void
  placeholder?: string
  minRows?: number
  autoFocus?: boolean
  toolbarExtra?: ReactNode
  id?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [mode, setMode] = useState<Mode>('write')

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  const update = (next: string, selStart: number, selEnd: number) => {
    onChange(next)
    requestAnimationFrame(() => {
      const ta = ref.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(selStart, selEnd)
    })
  }

  const wrap = (before: string, after = before, sample = '') => {
    const ta = ref.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const sel = value.slice(s, e) || sample
    const next = value.slice(0, s) + before + sel + after + value.slice(e)
    update(next, s + before.length, s + before.length + sel.length)
  }

  const prefixLines = (prefix: (i: number) => string) => {
    const ta = ref.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const lineStart = value.lastIndexOf('\n', s - 1) + 1
    const block = value.slice(lineStart, e)
    const lines = block.split('\n').map((l, i) => prefix(i) + l)
    const replaced = lines.join('\n')
    const next = value.slice(0, lineStart) + replaced + value.slice(e)
    update(next, lineStart, lineStart + replaced.length)
  }

  const insert = (text: string) => {
    const ta = ref.current
    if (!ta) return
    const { selectionStart: s, selectionEnd: e } = ta
    const next = value.slice(0, s) + text + value.slice(e)
    update(next, s + text.length, s + text.length)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'b' || k === 'и') {
      e.preventDefault()
      wrap('**', '**', t.editor.sampleText)
    } else if (k === 'i' || k === 'ш') {
      e.preventDefault()
      wrap('_', '_', t.editor.sampleText)
    } else if ((k === 's' || k === 'ы') && onSave) {
      e.preventDefault()
      onSave()
    }
  }

  const tools: { label: string; icon: ReactNode; run: () => void }[] = [
    { label: t.editor.bold, icon: <Bold className="size-4" />, run: () => wrap('**', '**', t.editor.sampleText) },
    { label: t.editor.italic, icon: <Italic className="size-4" />, run: () => wrap('_', '_', t.editor.sampleText) },
    { label: t.editor.heading, icon: <Heading2 className="size-4" />, run: () => prefixLines(() => '## ') },
    { label: t.editor.list, icon: <List className="size-4" />, run: () => prefixLines(() => '- ') },
    { label: t.editor.numbered, icon: <ListOrdered className="size-4" />, run: () => prefixLines((i) => `${i + 1}. `) },
    { label: t.editor.checklist, icon: <ListChecks className="size-4" />, run: () => prefixLines(() => '- [ ] ') },
    { label: t.editor.quote, icon: <Quote className="size-4" />, run: () => prefixLines(() => '> ') },
    { label: t.editor.code, icon: <Code className="size-4" />, run: () => wrap('`', '`', t.editor.sampleCode) },
    { label: t.editor.link, icon: <Link2 className="size-4" />, run: () => wrap('[', '](https://)', t.editor.sampleLink) },
    {
      label: t.editor.table,
      icon: <Table className="size-4" />,
      run: () => insert(t.editor.tableTemplate),
    },
  ]

  const modeBtn = (m: Mode, label: string, icon: ReactNode, extra?: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors',
        mode === m ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
        extra,
      )}
    >
      {icon}
      {label}
    </button>
  )

  const rows = Math.max(minRows, Math.min(40, value.split('\n').length + 2))

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-2 py-1.5">
        <div className={cn('flex flex-wrap items-center gap-0.5', mode === 'preview' && 'invisible')}>
          {tools.map((tool) => (
            <button
              key={tool.label}
              type="button"
              title={tool.label}
              aria-label={tool.label}
              onClick={tool.run}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {tool.icon}
            </button>
          ))}
          {toolbarExtra}
        </div>
        <div className="flex items-center gap-0.5 rounded-lg bg-paper p-0.5">
          {modeBtn('write', t.editor.write, <PencilLine className="size-3.5" />)}
          {modeBtn('split', t.editor.split, <Columns2 className="size-3.5" />, 'hidden lg:inline-flex')}
          {modeBtn('preview', t.editor.preview, <Eye className="size-3.5" />)}
        </div>
      </div>
      <div className={cn(mode === 'split' && 'lg:grid lg:grid-cols-2 lg:divide-x lg:divide-line')}>
        {mode !== 'preview' && (
          <textarea
            id={id}
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            rows={rows}
            spellCheck
            className="block w-full resize-y border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed text-ink placeholder:text-muted/70 focus:outline-none"
          />
        )}
        {mode !== 'write' && (
          <div className={cn('min-h-40 px-4 py-3', mode === 'split' && 'max-h-[70vh] overflow-y-auto')}>
            {value.trim() ? <Markdown>{value}</Markdown> : <p className="text-sm text-muted">{t.editor.nothingToPreview}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
