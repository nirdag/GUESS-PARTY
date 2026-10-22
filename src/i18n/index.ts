import en from './en.json'
import he from './he.json'

export type LanguageCode = 'en' | 'he'

export type LanguageMeta = {
  code: LanguageCode
  nativeName: string
  dir: 'ltr' | 'rtl'
  flagSvg: string
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 40" aria-hidden="true" focusable="false">${body}</svg>`

const flagEn = svg(
  '<rect width="60" height="40" fill="#012169"/>' +
  '<path d="M0 0L60 40M60 0L0 40" stroke="#fff" stroke-width="8"/>' +
  '<path d="M0 0L60 40M60 0L0 40" stroke="#C8102E" stroke-width="3"/>' +
  '<path d="M30 0V40M0 20H60" stroke="#fff" stroke-width="13"/>' +
  '<path d="M30 0V40M0 20H60" stroke="#C8102E" stroke-width="8"/>',
)

const flagHe = svg(
  '<rect width="60" height="40" fill="#fff"/>' +
  '<rect y="4" width="60" height="5" fill="#0038b8"/>' +
  '<rect y="31" width="60" height="5" fill="#0038b8"/>' +
  '<g fill="none" stroke="#0038b8" stroke-width="1.6">' +
  '<path d="M30 12L36 23H24Z"/><path d="M30 26L24 15H36Z"/></g>',
)

// Adding a new language: create src/i18n/<code>.json and register it here (with a flag SVG).
export const languages: Record<LanguageCode, LanguageMeta> = {
  en: { code: 'en', nativeName: 'English', dir: 'ltr', flagSvg: flagEn },
  he: { code: 'he', nativeName: 'עברית', dir: 'rtl', flagSvg: flagHe },
}

const dictionaries: Record<LanguageCode, Record<string, string>> = { en, he }

const languageStorageKey = 'guess-party-language'
const fallbackLanguage: LanguageCode = 'he'

export function isSupportedLanguage(value: string | null | undefined): value is LanguageCode {
  return Boolean(value) && Object.prototype.hasOwnProperty.call(languages, value as string)
}

export function readStoredLanguage(): LanguageCode | null {
  try {
    const stored = window.localStorage.getItem(languageStorageKey)
    return isSupportedLanguage(stored) ? stored : null
  } catch {
    return null
  }
}

let currentLanguage: LanguageCode = readStoredLanguage() ?? fallbackLanguage

export function getLanguage(): LanguageCode {
  return currentLanguage
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) {
    return template
  }

  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = params[key]
    return value === undefined ? match : String(value)
  })
}

export function t(key: string, params?: Record<string, string | number>): string {
  const template = dictionaries[currentLanguage][key] ?? dictionaries[fallbackLanguage][key] ?? key
  return interpolate(template, params)
}

export function applyDocumentDirection(language: LanguageCode): void {
  const meta = languages[language] ?? languages[fallbackLanguage]
  document.documentElement.lang = meta.code
  document.documentElement.dir = meta.dir
}

export function setLanguage(language: LanguageCode): void {
  currentLanguage = isSupportedLanguage(language) ? language : fallbackLanguage
  applyDocumentDirection(currentLanguage)

  try {
    window.localStorage.setItem(languageStorageKey, currentLanguage)
  } catch {
    // Language selection still works for this page load without persistence.
  }
}

applyDocumentDirection(currentLanguage)
