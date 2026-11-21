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
export function readYandexToken(library: Library): string | null {
  const { token, tokenEncrypted } = library.getYandexTokenBlob()
  if (!token || token.length === 0) return null
  const bytes = Buffer.from(token)
  try {
    if (tokenEncrypted) return safeStorage.decryptString(bytes)
    if (!encryptionAvailable()) return null
    const legacyToken = bytes.toString('utf8')
    writeYandexToken(library, legacyToken)
    return legacyToken
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
  if (!encryptionAvailable()) throw new Error('Системное шифрование недоступно. Токен не сохранён.')
  library.setYandexTokenBlob(new Uint8Array(safeStorage.encryptString(trimmed)), true)
}

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
}

export function hasYandexToken(library: Library): boolean {
  return (readYandexToken(library) ?? '').length > 0
}
