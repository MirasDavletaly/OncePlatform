import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '@fontsource-variable/golos-text'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import { App } from './App'
import { ConfirmProvider, ToastProvider } from './components/ui'
import { ApiError } from './lib/api'

// A deploy removes the previous build's page chunks: an old tab that fails
// to load one reloads itself to pick up the new build - at most once in 30 s,
// so a chunk that keeps failing does not make every tab reload in a loop.
window.addEventListener('vite:preloadError', () => {
  try {
    const last = Number(sessionStorage.getItem('chunk-reload') || 0)
    if (Date.now() - last < 30_000) return
    sessionStorage.setItem('chunk-reload', String(Date.now()))
  } catch {
    return // no storage: no automatic reload rather than a possible loop
  }
  window.location.reload()
})

// Server state is cached only in memory (TanStack Query); nothing is
// persisted in the browser.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ToastProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </ToastProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
