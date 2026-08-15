import en from './en.json'
import he from './he.json'

export type LanguageCode = 'en' | 'he'

export type LanguageMeta = {
  code: LanguageCode
  nativeName: string
  dir: 'ltr' | 'rtl'
}

// Adding a new language: create src/i18n/<code>.json and register it here.
export const languages: Record<LanguageCode, LanguageMeta> = {
  en: { code: 'en', nativeName: 'English', dir: 'ltr' },
  he: { code: 'he', nativeName: 'עברית', dir: 'rtl' },
}

const dictionaries: Record<LanguageCode, Record<string, string>> = { en, he }

const languageStorageKey = 'guess-party-language'
const fallbackLanguage: LanguageCode = 'en'

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
