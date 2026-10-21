import { useEffect, useState } from 'react'

// The theme choice is the only value kept in browser storage (allowed by the
// spec); all business data stays on the server.
export type ThemeChoice = 'light' | 'dark' | 'system'

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem('theme')
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // storage unavailable
  }
  return 'system'
}

function apply(choice: ThemeChoice) {
  const dark =
    choice === 'dark' || (choice === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)
  useEffect(() => {
    apply(choice)
    if (choice !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [choice])
  const set = (c: ThemeChoice) => {
    try {
      localStorage.setItem('theme', c)
    } catch {
      // ignore
    }
    setChoice(c)
  }
  return [choice, set]
}
