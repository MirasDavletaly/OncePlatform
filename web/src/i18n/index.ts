import { en, type Dict } from './en'
import { ru } from './ru'

export type Language = 'en' | 'ru'

const dictionaries: Record<Language, Dict> = { en, ru }

// The active dictionary. English is the primary language; the user's choice
// is stored on the server (users.language) and applied by setLanguage().
// Components read `t` during render, so a re-render after setLanguage()
// shows the new language (ES module exports are live bindings).
export let t: Dict = en
export let language: Language = 'en'

export function setLanguage(lang: string) {
  const l: Language = lang === 'ru' ? 'ru' : 'en'
  language = l
  t = dictionaries[l]
  document.documentElement.lang = l
}

/** Fills {name} placeholders in a dictionary string. */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in vars ? String(vars[key]) : m))
}

/** Picks the plural form for n from [one, few, many] in the active language. */
export function plural(n: number, forms: readonly string[]): string {
  if (language === 'en') return Math.abs(n) === 1 ? forms[0] : forms[1]
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return forms[2]
  if (last > 1 && last < 5) return forms[1]
  if (last === 1) return forms[0]
  return forms[2]
}
