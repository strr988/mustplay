import { beforeEach, expect, it, vi } from 'vitest'
import { readYandexToken, writeYandexToken } from '../src/main/yandex-token'
import type { Library } from '../src/main/library'

const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  getSelectedStorageBackend: vi.fn(() => 'kwallet'),
  encryptString: vi.fn(() => Buffer.from('encrypted')),
  decryptString: vi.fn(() => 'fixture-token'),
}))
vi.mock('electron', () => ({ safeStorage: storage }))

function profile(token: Uint8Array | null = null, tokenEncrypted = false) {
  const save = vi.fn()
  return {
    save,
    library: { getYandexTokenBlob: () => ({ token, tokenEncrypted }), setYandexTokenBlob: save } as unknown as Library,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  storage.isEncryptionAvailable.mockReturnValue(true)
})

it('refuses to persist or use plaintext when system encryption is unavailable', () => {
  storage.isEncryptionAvailable.mockReturnValue(false)
  const { library, save } = profile(Buffer.from('fixture-token'))
  expect(() => writeYandexToken(library, 'other-token')).toThrow(/шифрование/)
  expect(readYandexToken(library)).toBeNull()
  expect(save).not.toHaveBeenCalled()
  writeYandexToken(library, '')
  expect(save).toHaveBeenCalledWith(null, false)
})

it('upgrades a legacy plaintext token before using it', () => {
  const { library, save } = profile(Buffer.from('fixture-token'))
  expect(readYandexToken(library)).toBe('fixture-token')
  expect(save).toHaveBeenCalledWith(Uint8Array.from(Buffer.from('encrypted')), true)
})
