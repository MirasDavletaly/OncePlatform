/** Joins class names, skipping falsy values. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

/** Copies text to the clipboard (falls back to a hidden textarea). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

/** Safe "next" redirect target: only same-site absolute paths. */
export function safeNext(next: string | null): string | null {
  if (!next) return null
  // browsers drop tabs and newlines and read "\" as "/": "/\t/evil.com" would become "//evil.com"
  // eslint-disable-next-line no-control-regex
  if (!next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next) || next.startsWith('//')) return null
  return next
}
