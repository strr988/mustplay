import { describe, expect, it } from 'vitest'
import { humanizeIpcError } from '../src/renderer/src/ipc-error'

describe('IPC error messages', () => {
  it('strips the Electron invocation prefix', () => {
    expect(humanizeIpcError(new Error(
      "Error invoking remote method 'pipeline:start': Error: Трек защищён DRM в источнике",
    ))).toBe('Трек защищён DRM в источнике')
  })

  it('strips the prefix without a nested Error label', () => {
    expect(humanizeIpcError(new Error(
      "Error invoking remote method 'yandex:set-token': Токен отклонён",
    ))).toBe('Токен отклонён')
  })

  it('collapses repeated Error labels', () => {
    expect(humanizeIpcError(new Error('Error: Error: Не удалось скачать трек'))).toBe('Не удалось скачать трек')
  })

  it('keeps a plain message untouched', () => {
    expect(humanizeIpcError(new Error('В плейлисте нет треков'))).toBe('В плейлисте нет треков')
  })

  it('accepts a string rejection', () => {
    expect(humanizeIpcError("Error invoking remote method 'x': Error: Плохой ввод")).toBe('Плохой ввод')
  })

  it('falls back when there is nothing readable', () => {
    expect(humanizeIpcError(new Error(''), 'Не удалось начать импорт.')).toBe('Не удалось начать импорт.')
    expect(humanizeIpcError(undefined, 'Не удалось начать импорт.')).toBe('Не удалось начать импорт.')
  })

  it('does not leak the remote method name for any pipeline action', () => {
    for (const action of ['pipeline:start', 'pipeline:retry', 'pipeline:skip', 'yandex:set-token']) {
      const text = humanizeIpcError(new Error(`Error invoking remote method '${action}': Error: Причина`))
      expect(text).toBe('Причина')
      expect(text).not.toContain(action)
    }
  })
})
