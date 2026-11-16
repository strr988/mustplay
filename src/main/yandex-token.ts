import { safeStorage } from 'electron'
import type { Library } from './library'

/**
 * The single place the Yandex Music token lives.
 *
 * Both the search tab and the import pipeline read it here, so a token saved in
 * one place works in the other. It is encrypted with the OS keystore when one
 * is available and never leaves Main: the interface only learns whether a
 * token exists.
 */
export const yandexTokenHelpUrl = 'https://ym-token.marshal.dev/'

/** The helper is a third-party service, so the interface warns about it. */
export const yandexTokenPage = yandexTokenHelpUrl

export function readYandexToken(library: Library): string | null {
  const { token, tokenEncrypted } = library.getYandexTokenBlob()
  if (!token || token.length === 0) return null
  const bytes = Buffer.from(token)
  try {
    return tokenEncrypted ? safeStorage.decryptString(bytes) : bytes.toString('utf8')
  } catch {
    // A profile copied from another machine cannot be decrypted here.
    return null
  }
}

export function writeYandexToken(library: Library, token: string | null): void {
  const trimmed = token?.trim() ?? ''
  if (!trimmed) {
    library.setYandexTokenBlob(null, false)
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    library.setYandexTokenBlob(new Uint8Array(safeStorage.encryptString(trimmed)), true)
  } else {
    // DPAPI/keyring is unavailable on this system; the token stays local to the profile.
    library.setYandexTokenBlob(new Uint8Array(Buffer.from(trimmed, 'utf8')), false)
  }
}

export function hasYandexToken(library: Library): boolean {
  return (readYandexToken(library) ?? '').length > 0
}
