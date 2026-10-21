import { createContext, useContext, type ReactNode } from 'react'
import type { Me, Meta, Permission } from './types'

// Session context: the current user, their permissions and server metadata.
// Everything comes from the server on page load; nothing is persisted locally.

interface SessionValue {
  me: Me
  meta: Meta
  can: (p: Permission) => boolean
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ me, meta, children }: { me: Me; meta: Meta; children: ReactNode }) {
  const can = (p: Permission) => me.permissions.includes(p)
  return <SessionContext.Provider value={{ me, meta, can }}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext)
  if (!v) throw new Error('useSession outside SessionProvider')
  return v
}
