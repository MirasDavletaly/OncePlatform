import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  Bot,
  ClipboardList,
  Columns3,
  IdCard,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  ScrollText,
  Search,
  Settings2,
  Sun,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { t } from '../i18n'
import { api } from '../lib/api'
import { timeAgo } from '../lib/format'
import { useSession } from '../lib/session'
import { useTheme, type ThemeChoice } from '../lib/theme'
import type { Notification } from '../lib/types'
import { cn } from '../lib/utils'
import { buttonClass, IconButton } from './ui'
import { LanguageToggle, useSaveLanguage } from './LanguageToggle'

function NavItem({ to, icon, label, end, onClick }: { to: string; icon: ReactNode; label: string; end?: boolean; onClick?: () => void }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] font-medium transition-colors',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink',
        )
      }
    >
      <span className="[&>svg]:size-[18px]">{icon}</span>
      {label}
    </NavLink>
  )
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-3">
      <svg viewBox="0 0 64 64" className="size-8 shrink-0" aria-hidden>
        <rect width="64" height="64" rx="14" fill="var(--accent)" />
        <circle cx="32" cy="32" r="15" fill="none" stroke="var(--gold-fill)" strokeWidth="6" />
        <path d="M32 22v10l7 5" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="leading-tight">
        <span className="block font-display text-[15px] font-semibold tracking-tight">{t.app.name}</span>
        <span className="block text-[11px] text-muted">{t.app.tagline}</span>
      </span>
    </Link>
  )
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { can } = useSession()
  const admin = can('admin.users') || can('admin.audit') || can('admin.oauth_clients')
  const tasks = can('view') // the recruiter sees the CV database only
  return (
    <div className="flex h-full flex-col gap-6 py-5">
      <Brand />
      <nav className="flex flex-col gap-0.5 px-3" aria-label={t.nav.menu}>
        {tasks && <NavItem to="/" end icon={<LayoutDashboard />} label={t.nav.dashboard} onClick={onNavigate} />}
        {tasks && <NavItem to="/kanban" icon={<Columns3 />} label={t.nav.kanban} onClick={onNavigate} />}
        {tasks && <NavItem to="/tickets" icon={<ClipboardList />} label={t.nav.tickets} onClick={onNavigate} />}
        {can('cv.view') && <NavItem to="/cv" icon={<IdCard />} label={t.nav.cv} onClick={onNavigate} />}
        {tasks && <NavItem to="/search" icon={<Search />} label={t.nav.search} onClick={onNavigate} />}
      </nav>
      {admin && (
        <nav className="flex flex-col gap-0.5 px-3" aria-label={t.nav.admin}>
          <p className="px-3 pb-1 text-[11px] font-semibold tracking-wider text-muted uppercase">{t.nav.admin}</p>
          {can('admin.users') && <NavItem to="/admin/users" icon={<Users />} label={t.nav.users} onClick={onNavigate} />}
          {can('admin.audit') && <NavItem to="/admin/audit" icon={<ScrollText />} label={t.nav.audit} onClick={onNavigate} />}
          {can('admin.oauth_clients') && (
            <NavItem to="/admin/oauth" icon={<Settings2 />} label={t.nav.oauthClients} onClick={onNavigate} />
          )}
        </nav>
      )}
      {tasks && (
        <div className="mt-auto px-3">
          <NavItem to="/settings/claude" icon={<Bot />} label={t.nav.connectClaude} onClick={onNavigate} />
        </div>
      )}
    </div>
  )
}

function NotificationBell() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const count = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<{ unread: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
  })
  const list = useQuery({
    queryKey: ['notifications', 'latest'],
    queryFn: () => api.get<{ items: Notification[] }>('/notifications?page_size=8'),
    enabled: open,
  })
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const unread = count.data?.unread ?? 0
  const openItem = (n: Notification) => {
    if (!n.read_at) read.mutate(n.id)
    setOpen(false)
    if (n.ticket_number) navigate(`/tickets/${n.ticket_number}`)
  }
  return (
    <div className="relative" ref={box}>
      <IconButton label={t.nav.notifications} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Bell className="size-[18px]" />
        {unread > 0 && (
          <span className="num absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white dark:text-[#2a0a07]">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </IconButton>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(92vw,380px)] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="text-sm font-semibold">{t.notifications.title}</span>
            <Link to="/notifications" onClick={() => setOpen(false)} className="text-[13px] text-accent hover:underline">
              {t.notifications.allPage}
            </Link>
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {list.isPending && <li className="px-4 py-6 text-center text-sm text-muted">{t.app.loading}</li>}
            {list.data?.items.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">{t.notifications.empty}</li>}
            {list.data?.items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => openItem(n)}
                  className={cn('flex w-full gap-3 border-b border-line px-4 py-3 text-left last:border-0 hover:bg-surface-2')}
                >
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-accent-bright')} />
                  <span className="min-w-0">
                    <span className="block text-[13px] leading-snug">{n.text}</span>
                    <span className="mt-0.5 block text-[12px] text-muted">{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const { me, can } = useSession()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [theme, setTheme] = useTheme()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  const setLang = useSaveLanguage()
  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      qc.clear()
      qc.setQueryData(['me'], null)
      navigate('/login')
    },
  })
  const initials = me.user.full_name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
  const themeBtn = (c: ThemeChoice, label: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => setTheme(c)}
      aria-pressed={theme === c}
      title={label}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px]',
        theme === c ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
      )}
    >
      {icon}
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  )
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-surface-2"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-[12px] font-semibold text-accent">
          {initials}
        </span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-40 truncate text-[13px] font-medium">{me.user.full_name}</span>
          <span className="block text-[11px] text-muted">{t.role[me.user.role]}</span>
        </span>
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-surface p-2 shadow-2xl">
          <div className="px-3 py-2">
            <p className="truncate text-sm font-medium">{me.user.full_name}</p>
            <p className="truncate text-[12px] text-muted">@{me.user.username}</p>
          </div>
          <div className="my-1 border-t border-line" />
          <Link
            to="/profile"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-surface-2"
          >
            <UserRound className="size-4 text-muted" /> {t.nav.profile}
          </Link>
          {can('view') && (
            <Link
              to="/settings/claude"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-surface-2"
            >
              <Bot className="size-4 text-muted" /> {t.nav.connectClaude}
            </Link>
          )}
          <div className="px-3 pt-2 pb-1 text-[12px] text-muted">{t.nav.theme}</div>
          <div className="mx-2 mb-1 flex gap-1 rounded-lg bg-paper p-1">
            {themeBtn('light', t.nav.themeLight, <Sun className="size-3.5" />)}
            {themeBtn('dark', t.nav.themeDark, <Moon className="size-3.5" />)}
            {themeBtn('system', t.nav.themeSystem, <Monitor className="size-3.5" />)}
          </div>
          <div className="px-3 pt-2 pb-1 text-[12px] text-muted">
            <Languages className="mr-1 inline size-3.5" aria-hidden />
            {t.nav.language}
          </div>
          <div className="mx-2 mb-1">
            <LanguageToggle className="w-full [&>button]:flex-1" disabled={setLang.isPending} onChange={(l) => setLang.mutate(l)} />
          </div>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            onClick={() => logout.mutate()}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2"
          >
            <LogOut className="size-4 text-muted" /> {t.nav.logout}
          </button>
        </div>
      )}
    </div>
  )
}

function GlobalSearch() {
  const navigate = useNavigate()
  const location = useLocation()
  const [q, setQ] = useState('')
  useEffect(() => {
    if (location.pathname === '/search') {
      setQ(new URLSearchParams(location.search).get('q') ?? '')
    }
  }, [location])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (q.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(q.trim())}`)
  }
  return (
    <form onSubmit={submit} role="search" className="relative hidden max-w-md flex-1 sm:block">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t.nav.searchPlaceholder}
        aria-label={t.nav.search}
        className="h-9 w-full rounded-lg border border-line bg-surface-2 pr-3 pl-9 text-sm placeholder:text-muted/80 focus:border-accent focus:bg-surface focus:outline-none focus:ring-2 focus:ring-accent/20"
      />
    </form>
  )
}

function TopBarLanguage() {
  const setLang = useSaveLanguage()
  return <LanguageToggle className="hidden sm:inline-flex" disabled={setLang.isPending} onChange={(l) => setLang.mutate(l)} />
}

export function Layout({ children }: { children: ReactNode }) {
  const { can } = useSession()
  const [drawer, setDrawer] = useState(false)
  const location = useLocation()
  useEffect(() => setDrawer(false), [location.pathname])
  return (
    <div className="min-h-screen lg:pl-60">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-[#06111a]/50" onClick={() => setDrawer(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-surface shadow-2xl">
            <IconButton label={t.nav.closeMenu} onClick={() => setDrawer(false)} className="absolute top-4 right-3">
              <X className="size-5" />
            </IconButton>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur sm:px-6">
        <IconButton label={t.nav.menu} onClick={() => setDrawer(true)} className="-ml-2 lg:hidden">
          <Menu className="size-5" />
        </IconButton>
        {can('view') && <GlobalSearch />}
        <div className="ml-auto flex items-center gap-1.5">
          {can('view') && (
            <Link
              to="/search"
              aria-label={t.nav.search}
              className="inline-flex size-9 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink sm:hidden"
            >
              <Search className="size-[18px]" />
            </Link>
          )}
          {can('ticket.create') && (
            <Link to="/tickets/new" className={buttonClass('primary', 'sm', 'hidden sm:inline-flex')}>
              <Plus className="size-4" />
              {t.nav.newTicket}
            </Link>
          )}
          <TopBarLanguage />
          {can('view') && <NotificationBell />}
          <UserMenu />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:py-8">{children}</main>
    </div>
  )
}
