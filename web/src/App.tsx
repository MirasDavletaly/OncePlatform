import { useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, api, onUnauthorized } from './lib/api'
import { language, setLanguage } from './i18n'
import { setTimezone } from './lib/format'
import { SessionProvider, useSession } from './lib/session'
import type { Me, Meta, Permission } from './lib/types'
import { ErrorState, Loading } from './components/ui'
import { Layout } from './components/Layout'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import { KanbanPage } from './pages/KanbanPage'
import { TicketsPage } from './pages/TicketsPage'
import { TicketNewPage } from './pages/TicketNewPage'
import { TicketPage } from './pages/ticket/TicketPage'
import { SearchPage } from './pages/SearchPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { ProfilePage } from './pages/ProfilePage'
import { ConnectClaudePage } from './pages/ConnectClaudePage'
import { AdminUsersPage } from './pages/admin/AdminUsersPage'
import { AdminAuditPage } from './pages/admin/AdminAuditPage'
import { AdminOAuthPage } from './pages/admin/AdminOAuthPage'
import { NotFoundPage } from './pages/NotFoundPage'

async function fetchMe(): Promise<Me | null> {
  try {
    return await api.get<Me>('/auth/me')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

export function App() {
  const qc = useQueryClient()
  const location = useLocation()
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<Meta>('/meta'), staleTime: Infinity })
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, staleTime: 60_000 })

  useEffect(() => {
    onUnauthorized(() => qc.setQueryData(['me'], null))
  }, [qc])

  if (meta.data) setTimezone(meta.data.timezone)
  // The interface language is the signed-in user's server-side preference
  // (English by default); on the sign-in page the toggle there decides.
  if (me.data) setLanguage(me.data.user.language)

  if (meta.isPending || me.isPending) return <Loading className="min-h-screen" />
  if (meta.isError) return <ErrorState error={meta.error} onRetry={() => meta.refetch()} />
  if (me.isError) return <ErrorState error={me.error} onRetry={() => me.refetch()} />

  if (location.pathname === '/login') {
    return <LoginPage loggedIn={!!me.data} />
  }
  if (!me.data) {
    const next = location.pathname + location.search
    return <Navigate to={`/login${next && next !== '/' ? '?next=' + encodeURIComponent(next) : ''}`} replace />
  }

  return (
    <SessionProvider me={me.data} meta={meta.data}>
      <Layout key={language}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/kanban" element={<KanbanPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/tickets/new" element={<Guard perm="ticket.create"><TicketNewPage /></Guard>} />
          <Route path="/tickets/:ref" element={<TicketPage />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/settings/claude" element={<ConnectClaudePage />} />
          <Route path="/admin/users" element={<Guard perm="admin.users"><AdminUsersPage /></Guard>} />
          <Route path="/admin/audit" element={<Guard perm="admin.audit"><AdminAuditPage /></Guard>} />
          <Route path="/admin/oauth" element={<Guard perm="admin.oauth_clients"><AdminOAuthPage /></Guard>} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Layout>
    </SessionProvider>
  )
}

/** Hides pages the role cannot use (the server enforces the same rules). */
function Guard({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useSession()
  return can(perm) ? <>{children}</> : <NotFoundPage />
}
