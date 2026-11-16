import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { coverUrl, decryptEncraw, fileInfoSign, fullTitle, lyricsSign, normalizeTrack, parseEncrawKey, trackEntry } from '../src/main/yandex-api'

describe('request signing', () => {
  it('matches the reference file-info signature', () => {
    expect(fileInfoSign('123', 'lossless', 1700000000)).toBe('N9bTnfdbcd587Q0/Ok43zh+vJj83ydy9l7glsFRaeG8')
  })
  it('matches the reference lyrics signature', () => {
    expect(lyricsSign('123', 1700000000)).toBe('0Vud0sSibSPxZ9g889XHJBtHLa1dj/Cn39Hi8FCKB3g=')
  })
})

describe('encraw decryption', () => {
  const keyHex = 'c132d83a1e2c383352cf3f5c2f4477115a775d49a84964da3df608b2b948b458'
  it('reverses AES-256-CTR with a zero counter block', () => {
    const data = Buffer.from('mustplay encraw payload '.repeat(500))
    const encrypted = createCipheriv('aes-256-ctr', Buffer.from(keyHex, 'hex'), Buffer.alloc(16, 0)).update(data)
    expect(decryptEncraw(encrypted, keyHex)).toEqual(data)
  })
  it('rejects a key of the wrong length', () => {
    expect(() => decryptEncraw(Buffer.alloc(16), 'abcd')).toThrow()
  })
})

describe('track normalization', () => {
  it('reads camelCase API fields', () => {
    const track = normalizeTrack({
      id: 42, title: 'Song', version: 'Remix', available: true, durationMs: 200000,
      coverUri: 'avatars.yandex.net/get-music/%%/cover',
      artists: [{ id: 1, name: 'Artist A' }, { id: 2, name: 'Artist B' }],
      albums: [{ id: 9, title: 'Album', year: 2021, genre: 'rock', coverUri: 'album/%%', trackPosition: { index: 2, volume: 1 }, artists: [{ id: 1, name: 'Artist A' }] }],
      lyricsInfo: { hasAvailableSyncLyrics: true, hasAvailableTextLyrics: true },
    })
    expect(track).not.toBeNull()
    expect(track!.id).toBe('42')
    expect(fullTitle(track!)).toBe('Song (Remix)')
    expect(track!.durationMs).toBe(200000)
    expect(track!.artists.map(artist => artist.name)).toEqual(['Artist A', 'Artist B'])
    expect(track!.album?.position).toEqual({ index: 2, volume: 1 })
    expect(track!.hasSyncLyrics).toBe(true)
    expect(track!.coverUri).toBe('avatars.yandex.net/get-music/%%/cover')
  })
  it('reads snake_case fallbacks and defaults availability', () => {
    const track = normalizeTrack({ id: '7', title: 'T', duration_ms: 1000, cover_uri: 'c/%%', lyrics_info: { has_available_text_lyrics: true } })
    expect(track!.durationMs).toBe(1000)
    expect(track!.available).toBe(true)
    expect(track!.hasTextLyrics).toBe(true)
    expect(track!.hasSyncLyrics).toBe(false)
    expect(track!.album).toBeNull()
  })
  it('rejects entries without an id', () => {
    expect(normalizeTrack({ title: 'no id' })).toBeNull()
    expect(normalizeTrack(null)).toBeNull()
  })
})

describe('encraw key parsing', () => {
  const key = Buffer.alloc(32, 9)
  it('accepts hex and base64 encodings of a 32-byte key', () => {
    expect(parseEncrawKey(key.toString('hex'))).toEqual(key)
    expect(parseEncrawKey(key.toString('hex').toUpperCase())).toEqual(key)
    expect(parseEncrawKey(key.toString('base64'))).toEqual(key)
  })
  it('rejects truncated and malformed keys instead of silently truncating', () => {
    expect(parseEncrawKey('abcd')).toBeNull()
    expect(parseEncrawKey('zz'.repeat(32))).toBeNull()
    expect(parseEncrawKey(Buffer.alloc(31, 1).toString('hex'))).toBeNull()
  })
  it('signs the raw transport differently from encraw', () => {
    expect(fileInfoSign('123', 'lossless', 1700000000, 'raw')).not.toBe(fileInfoSign('123', 'lossless', 1700000000))
  })
})

describe('track entry unwrapping', () => {
  it('unwraps the invocation envelope returned by /tracks', () => {
    const track = { id: 42, title: 'Song' }
    expect(trackEntry({ invocationInfo: { hostname: 'x' }, result: [track] })).toEqual(track)
    expect(normalizeTrack(trackEntry({ result: [track] }))!.id).toBe('42')
  })
  it('accepts a bare array and a tracks list', () => {
    expect(trackEntry([{ id: 1 }])).toEqual({ id: 1 })
    expect(trackEntry({ tracks: [{ id: 2 }] })).toEqual({ id: 2 })
  })
  it('passes a single track object through', () => {
    expect(trackEntry({ id: 3, title: 'T' })).toEqual({ id: 3, title: 'T' })
    expect(trackEntry(null)).toBeNull()
  })
})

describe('cover url', () => {
  it('substitutes the size placeholder', () => {
    expect(coverUrl('avatars.yandex.net/get-music/%%/cover', '400x400')).toBe('https://avatars.yandex.net/get-music/400x400/cover')
    expect(coverUrl('x/%%', 'orig')).toBe('https://x/orig')
  })
})