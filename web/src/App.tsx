import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react'
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
import { NotFoundPage } from './pages/NotFoundPage'

// Pages behind sign-in are loaded on demand, so the sign-in page downloads
// only the code it needs (the small Layout stays in the main bundle).
function page<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })))
}
const DashboardPage = page(() => import('./pages/DashboardPage'), 'DashboardPage')
const KanbanPage = page(() => import('./pages/KanbanPage'), 'KanbanPage')
const TicketsPage = page(() => import('./pages/TicketsPage'), 'TicketsPage')
const TicketNewPage = page(() => import('./pages/TicketNewPage'), 'TicketNewPage')
const TicketPage = page(() => import('./pages/ticket/TicketPage'), 'TicketPage')
const SearchPage = page(() => import('./pages/SearchPage'), 'SearchPage')
const NotificationsPage = page(() => import('./pages/NotificationsPage'), 'NotificationsPage')
const ProfilePage = page(() => import('./pages/ProfilePage'), 'ProfilePage')
const ConnectClaudePage = page(() => import('./pages/ConnectClaudePage'), 'ConnectClaudePage')
const AdminUsersPage = page(() => import('./pages/admin/AdminUsersPage'), 'AdminUsersPage')
const AdminAuditPage = page(() => import('./pages/admin/AdminAuditPage'), 'AdminAuditPage')
const AdminOAuthPage = page(() => import('./pages/admin/AdminOAuthPage'), 'AdminOAuthPage')
const CvListPage = page(() => import('./pages/cv/CvListPage'), 'CvListPage')
const CvPage = page(() => import('./pages/cv/CvPage'), 'CvPage')
const CvPrintPage = page(() => import('./pages/cv/CvPrintPage'), 'CvPrintPage')
const RegisterPage = page(() => import('./pages/RegisterPage'), 'RegisterPage')

async function fetchMe(): Promise<Me | null> {
  try {
    // Anonymous visitors get 200 with "user": null (no 401 in the console).
    const me = await api.get<Me>('/auth/me')
    return me.user ? me : null
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
  // the shared registration link; a signed-in visitor goes on to the portal
  if (location.pathname.startsWith('/join/')) {
    if (me.data) return <Navigate to="/" replace />
    return (
      <Suspense fallback={<Loading className="min-h-screen" />}>
        <Routes>
          <Route path="/join/:token" element={<RegisterPage />} />
        </Routes>
      </Suspense>
    )
  }
  if (!me.data) {
    const next = location.pathname + location.search
    return <Navigate to={`/login${next && next !== '/' ? '?next=' + encodeURIComponent(next) : ''}`} replace />
  }

  // The printable CV is a bare page without the portal frame.
  if (/^\/cv\/[^/]+\/print$/.test(location.pathname)) {
    return (
      <SessionProvider me={me.data} meta={meta.data}>
        <Suspense fallback={<Loading className="min-h-screen" />}>
          <Routes>
            <Route path="/cv/:id/print" element={<Guard perm="cv.manage"><CvPrintPage /></Guard>} />
          </Routes>
        </Suspense>
      </SessionProvider>
    )
  }

  // The recruiter works with the CV database only: every other address leads there.
  if (!me.data.permissions.includes('view')) {
    return (
      <SessionProvider me={me.data} meta={meta.data}>
        <Layout key={language}>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/cv" element={<Guard perm="cv.view"><CvListPage /></Guard>} />
              <Route path="/cv/:id" element={<Guard perm="cv.view"><CvPage /></Guard>} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="*" element={<Navigate to="/cv" replace />} />
            </Routes>
          </Suspense>
        </Layout>
      </SessionProvider>
    )
  }

  return (
    <SessionProvider me={me.data} meta={meta.data}>
      <Layout key={language}>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/kanban" element={<KanbanPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/tickets/new" element={<Guard perm="ticket.create"><TicketNewPage /></Guard>} />
            <Route path="/tickets/:ref" element={<TicketPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/cv" element={<Guard perm="cv.view"><CvListPage /></Guard>} />
            <Route path="/cv/:id" element={<Guard perm="cv.view"><CvPage /></Guard>} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/settings/claude" element={<ConnectClaudePage />} />
            <Route path="/admin/users" element={<Guard perm="admin.users"><AdminUsersPage /></Guard>} />
            <Route path="/admin/audit" element={<Guard perm="admin.audit"><AdminAuditPage /></Guard>} />
            <Route path="/admin/oauth" element={<Guard perm="admin.oauth_clients"><AdminOAuthPage /></Guard>} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </Layout>
    </SessionProvider>
  )
}

/** Hides pages the role cannot use (the server enforces the same rules). */
function Guard({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can } = useSession()
  return can(perm) ? <>{children}</> : <NotFoundPage />
}
