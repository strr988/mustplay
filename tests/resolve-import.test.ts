import { describe, expect, it, vi } from 'vitest'
import { resolveImportUrl } from '../src/imports/resolve-import'
import type { ShortLinkReply, ShortLinkTransport } from '../src/imports/short-links'
import { ShortLinkError } from '../src/imports/short-links'

function reply(status: number, location: string | null): ShortLinkReply {
  return {
    status,
    location,
    body: async () => '',
    discard: async () => {},
  }
}

/** A transport that maps a short address to its redirect target. */
function redirects(map: Record<string, string>, calls: string[] = []): ShortLinkTransport {
  return {
    async send(url) {
      calls.push(url)
      const location = map[url]
      if (!location) return reply(404, null)
      return reply(302, location)
    },
  }
}

const failing: ShortLinkTransport = {
  async send() {
    throw new Error('getaddrinfo ENOTFOUND on.soundcloud.com')
  },
}

describe('resolveImportUrl', () => {
  it('reads a full Deezer playlist', async () => {
    const target = await resolveImportUrl('https://www.deezer.com/ru/playlist/1234567?utm_source=deezer')
    expect(target).toMatchObject({
      short: false,
      info: { provider: 'deezer', kind: 'playlist', supported: true },
      ref: { provider: 'deezer', id: '1234567' },
    })
    expect(target.ref.url).toBe('https://www.deezer.com/ru/playlist/1234567?utm_source=deezer')
  })

  it('reads a full Spotify playlist in all supported shapes', async () => {
    for (const url of [
      'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc',
      'https://open.spotify.com/intl-ru/playlist/37i9dQZF1DXcBWIGoYBM5M',
      'https://open.spotify.com/user/spotify/playlist/37i9dQZF1DXcBWIGoYBM5M',
      'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    ]) {
      const target = await resolveImportUrl(url)
      expect(target.ref).toMatchObject({ provider: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M' })
      expect(target.short).toBe(false)
    }
  })

  it('keeps the secret token of a SoundCloud set in the import address', async () => {
    const url = 'https://soundcloud.com/argonaut-398318058/sets/itsnotsobaddd/s-4xa2CO70vA7?si=bab7'
    const target = await resolveImportUrl(url)
    expect(target.ref).toMatchObject({ provider: 'soundcloud', id: 'itsnotsobaddd' })
    // The secret part is not the ID, but it must survive: yt-dlp needs the full address.
    expect(target.ref.url).toBe(url)
    expect(target.ref.url).toContain('/s-4xa2CO70vA7')
  })

  it('trims surrounding whitespace before parsing', async () => {
    const target = await resolveImportUrl('  https://soundcloud.com/forss/sets/soulhack  ')
    expect(target.ref).toMatchObject({ provider: 'soundcloud', id: 'soulhack' })
    expect(target.ref.url).toBe('https://soundcloud.com/forss/sets/soulhack')
  })

  it('resolves a short SoundCloud set link before parsing', async () => {
    const calls: string[] = []
    const target = await resolveImportUrl('https://on.soundcloud.com/abc123?si=xyz', {
      transport: redirects({
        'https://on.soundcloud.com/abc123?si=xyz': 'https://soundcloud.com/forss/sets/soulhack?si=xyz',
      }, calls),
    })
    expect(calls).toEqual(['https://on.soundcloud.com/abc123?si=xyz'])
    expect(target).toMatchObject({
      short: true,
      info: { provider: 'soundcloud', kind: 'set', supported: true },
      ref: { provider: 'soundcloud', id: 'soulhack' },
    })
    expect(target.ref.url).toBe('https://soundcloud.com/forss/sets/soulhack?si=xyz')
  })

  it('resolves short Deezer and Spotify links', async () => {
    const deezer = await resolveImportUrl('https://link.deezer.com/s/abc', {
      transport: redirects({ 'https://link.deezer.com/s/abc': 'https://www.deezer.com/playlist/7654321' }),
    })
    expect(deezer.ref).toMatchObject({ provider: 'deezer', id: '7654321' })
    expect(deezer.short).toBe(true)

    const spotify = await resolveImportUrl('https://spoti.fi/abc', {
      transport: redirects({ 'https://spoti.fi/abc': 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' }),
    })
    expect(spotify.ref).toMatchObject({ provider: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M' })
  })

  it('does not contact the network for a full link', async () => {
    const send = vi.fn()
    await resolveImportUrl('https://soundcloud.com/forss/sets/soulhack', {
      transport: { send },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('refuses a short link that expands to a single track', async () => {
    const error = await resolveImportUrl('https://on.soundcloud.com/abc', {
      transport: redirects({ 'https://on.soundcloud.com/abc': 'https://soundcloud.com/forss/soulhack' }),
    }).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('трек')
  })

  it('refuses a short link that expands to an unknown service', async () => {
    const error = await resolveImportUrl('https://on.soundcloud.com/abc', {
      transport: redirects({ 'https://on.soundcloud.com/abc': 'https://example.com/playlist/1' }),
    }).catch(value => value)
    // Redirect validation blocks it before parsing.
    expect((error as Error).message).toContain('посторонний адрес')
  })

  it('reports a broken shortener with the resolver wording', async () => {
    const error = await resolveImportUrl('https://on.soundcloud.com/abc', { transport: failing })
      .catch(value => value)
    expect((error as Error).message).toContain('VPN')
  })

  it('passes a resolver error kind through as a readable message', async () => {
    const error = await resolveImportUrl('https://on.soundcloud.com/abc', {
      transport: {
        async send() {
          throw new ShortLinkError('network', 'boom')
        },
      },
    }).catch(value => value)
    expect((error as Error).message).toContain('VPN')
  })

  it('refuses an unrecognised address', async () => {
    for (const url of ['', '   ', 'not a url', 'https://example.com/playlist/1', 'https://soundcloud.com.evil.example/a/sets/b']) {
      await expect(resolveImportUrl(url)).rejects.toThrow('Ссылка не распознана')
    }
  })

  it('explains Yandex before and after a saved token', async () => {
    const url = 'https://music.yandex.ru/users/demo/playlists/1'
    await expect(resolveImportUrl(url)).rejects.toThrow('Токен можно сохранить')
    await expect(resolveImportUrl(url, { yandexSaved: true })).rejects.toThrow('ещё не подключено')
  })

  it('explains VK and YouTube instead of attempting a download', async () => {
    await expect(resolveImportUrl('https://vk.com/music/playlist/123_456'))
      .rejects.toThrow('нет резолвера прямых ссылок')
    await expect(resolveImportUrl('https://music.youtube.com/playlist?list=OLAK5uy_kExample'))
      .rejects.toThrow('Откройте YT Music')
    // A YouTube short link is unsupported, so the resolver is never called.
    await expect(resolveImportUrl('https://youtu.be/dQw4w9WgXcQ', { transport: failing }))
      .rejects.toThrow('Откройте YT Music')
  })

  it('refuses an album or an artist page with a specific reason', async () => {
    await expect(resolveImportUrl('https://www.deezer.com/album/302127'))
      .rejects.toThrow('Ссылка на альбом не поддерживается')
    await expect(resolveImportUrl('https://open.spotify.com/artist/06HL4z0CvFAxyc27GXpf02'))
      .rejects.toThrow('Нужна ссылка на плейлист')
  })

  it('accepts a link without a protocol', async () => {
    const target = await resolveImportUrl('soundcloud.com/forss/sets/soulhack')
    expect(target.ref).toMatchObject({ provider: 'soundcloud', id: 'soulhack' })
    // The parser keeps the text as pasted; only the service and ID matter.
    expect(target.ref.url).toBe('soundcloud.com/forss/sets/soulhack')
  })
})
