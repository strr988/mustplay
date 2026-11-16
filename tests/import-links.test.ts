import { describe, expect, it } from 'vitest'
import { importActionLabel, linkNote, readLink, supportedLinks } from '../src/renderer/src/import-links'

describe('import link recognition', () => {
  it('accepts a SoundCloud set without a protocol', () => {
    const link = readLink('soundcloud.com/forss/sets/soulhack')
    expect(link).toMatchObject({ provider: 'soundcloud', kind: 'set', supported: true })
  })

  it('accepts public Deezer and Spotify playlists', () => {
    expect(readLink('https://www.deezer.com/ru/playlist/1234567')).toMatchObject({
      provider: 'deezer', kind: 'playlist', supported: true,
    })
    expect(readLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc')).toMatchObject({
      provider: 'spotify', kind: 'playlist', supported: true,
    })
  })

  it('refuses kinds the pipeline cannot import yet', () => {
    // The backend only resolves playlists and sets, so the button stays off.
    expect(readLink('https://soundcloud.com/forss/soulhack')).toMatchObject({ kind: 'track', supported: false })
    expect(readLink('https://www.deezer.com/album/302127')).toMatchObject({ kind: 'album', supported: false })
    expect(readLink('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toMatchObject({
      kind: 'track', supported: false,
    })
  })

  it('sends YouTube links to the web session instead of a dead import', () => {
    const video = readLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    const playlist = readLink('https://music.youtube.com/playlist?list=OLAK5uy_kExample')
    expect(video).toMatchObject({ provider: 'ytmusic', supported: false })
    expect(playlist).toMatchObject({ provider: 'ytmusic', supported: false })
    expect(linkNote(video!, false)).toContain('YT Music в плитке ниже')
  })

  it('keeps Yandex and VK visible but not importable', () => {
    expect(readLink('https://music.yandex.ru/users/demo/playlists/1')).toMatchObject({
      provider: 'yandex', supported: false,
    })
    expect(readLink('https://vk.com/music/playlist/123_456')).toMatchObject({
      provider: 'vk', supported: false,
    })
    expect(linkNote(readLink('https://vk.com/music/playlist/123_456')!, false)).toContain('нет резолвера')
  })

  it('flags sharing shorteners instead of guessing', () => {
    expect(readLink('https://spotify.link/abc123')).toMatchObject({ provider: 'spotify', short: true, supported: false })
    expect(readLink('https://on.soundcloud.com/abc123')).toMatchObject({ short: true, supported: false })
  })

  it('rejects unknown domains and unsafe schemes', () => {
    expect(readLink('https://example.com/playlist/1')).toBeNull()
    expect(readLink('file:///C:/music/playlist.mp3')).toBeNull()
    expect(readLink('javascript://alert(1)')).toBeNull()
    expect(readLink('   ')).toBeNull()
  })

  it('maps every advertised link shape to a working import', () => {
    // The hint under the field must never list something the parser rejects.
    expect(supportedLinks.length).toBeGreaterThan(0)
    for (const item of supportedLinks) {
      expect(readLink(item.url)).toMatchObject({
        provider: item.provider, kind: item.kind, supported: true,
      })
    }
  })

  it('names the action after the link kind', () => {
    expect(importActionLabel(readLink('https://soundcloud.com/forss/sets/soulhack'))).toBe('Импортировать сет')
    expect(importActionLabel(readLink('https://www.deezer.com/playlist/123'))).toBe('Импортировать плейлист')
    expect(importActionLabel(null)).toBe('Импортировать')
  })
})
