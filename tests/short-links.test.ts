import { describe, expect, it } from 'vitest'
import { detectImportLink } from '../src/shared/import-links'
import { parsePlaylistUrl } from '../src/metadata/providers/types'
import {
  fetchTransport, resolveShortLink, ShortLinkError, shortLinkFailureMessage, shortLinkSource,
} from '../src/imports/short-links'
import type { ShortLinkReply, ShortLinkTransport } from '../src/imports/short-links'

interface Step {
  status?: number
  location?: string
  body?: string
  /** Models a service that rejects HEAD and only answers GET. */
  rejectHead?: boolean
  /** Models a service that answers HEAD with an error status. */
  headStatus?: number
  /** Models an unreachable service for both methods. */
  fail?: string
}

interface Call {
  url: string
  method: 'HEAD' | 'GET'
  userAgent: string
}

function reply(status: number, location: string | null, body: string): ShortLinkReply {
  return {
    status,
    location,
    body: async () => body,
    discard: async () => {},
  }
}

function scriptedTransport(steps: Record<string, Step>, calls: Call[] = []): ShortLinkTransport {
  return {
    async send(url, { method, userAgent }) {
      calls.push({ url, method, userAgent })
      const step = steps[url]
      if (!step) return reply(404, null, '')
      if (step.fail) throw new Error(step.fail)
      if (method === 'HEAD' && step.rejectHead) throw new Error('HEAD rejected')
      if (method === 'HEAD' && step.headStatus) return reply(step.headStatus, null, '')
      return reply(step.status ?? 200, step.location ?? null, step.body ?? '')
    },
  }
}

describe('short link resolver', () => {
  it('unwraps on.soundcloud.com to the full set address', async () => {
    const calls: Call[] = []
    const resolved = await resolveShortLink('https://on.soundcloud.com/abc123?si=xyz', {
      transport: scriptedTransport({
        'https://on.soundcloud.com/abc123?si=xyz': {
          status: 302,
          location: 'https://soundcloud.com/forss/sets/soulhack?si=xyz',
        },
      }, calls),
    })
    expect(resolved).toBe('https://soundcloud.com/forss/sets/soulhack?si=xyz')
    expect(detectImportLink(resolved)).toMatchObject({ provider: 'soundcloud', kind: 'set', supported: true })
    // A redirect is answered by the headers alone: the service page is not loaded.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('HEAD')
  })

  it('falls back to GET when a shortener rejects HEAD', async () => {
    const calls: Call[] = []
    const resolved = await resolveShortLink('https://spoti.fi/abc', {
      transport: scriptedTransport({
        'https://spoti.fi/abc': {
          rejectHead: true,
          status: 301,
          location: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
        },
      }, calls),
    })
    expect(calls.map(call => call.method)).toEqual(['HEAD', 'GET'])
    expect(resolved).toBe('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')
  })

  it('retries with GET when HEAD answers 405', async () => {
    const calls: Call[] = []
    const resolved = await resolveShortLink('https://link.deezer.com/s/abc', {
      transport: scriptedTransport({
        'https://link.deezer.com/s/abc': {
          headStatus: 405,
          location: 'https://www.deezer.com/playlist/1234567',
        },
      }, calls),
    })
    expect(calls.map(call => call.method)).toEqual(['HEAD', 'GET'])
    expect(resolved).toBe('https://www.deezer.com/playlist/1234567')
  })

  it('reads the playlist Deezer hides in its landing-page query', async () => {
    const target = 'https://www.deezer.com/playlist/2097558104?host=0&utm_source=user_sharing'
    const landing = 'https://link.deezer.com/?awf=' + encodeURIComponent(target) +
      '&dest=' + encodeURIComponent(target) + '&gwf=' + encodeURIComponent(target)
    const calls: Call[] = []
    const resolved = await resolveShortLink('https://link.deezer.com/s/34YK04CocEvMouinnrk0F', {
      transport: scriptedTransport({
        'https://link.deezer.com/s/34YK04CocEvMouinnrk0F': { status: 301, location: landing },
      }, calls),
    })
    expect(resolved).toBe(target)
    expect(parsePlaylistUrl(resolved)).toMatchObject({ provider: 'deezer', id: '2097558104' })
    // One request: the landing page is never loaded.
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('HEAD')
  })

  it('ignores an embedded address that is not https or not the provider', async () => {
    const error = await resolveShortLink('https://link.deezer.com/s/abc', {
      transport: scriptedTransport({
        'https://link.deezer.com/s/abc': {
          status: 301,
          location: 'https://link.deezer.com/?awf=' + encodeURIComponent('http://www.deezer.com/playlist/1'),
        },
      }),
    }).catch(value => value)
    expect(error).toBeInstanceOf(ShortLinkError)
    expect((error as ShortLinkError).kind).toBe('blocked')
  })

  it('reads a meta refresh when the shortener answers 200', async () => {
    const resolved = await resolveShortLink('https://deezer.page.link/abc', {
      transport: scriptedTransport({
        'https://deezer.page.link/abc': {
          body: '<html><meta http-equiv="refresh" content="0; url=https://www.deezer.com/playlist/1234567"></html>',
        },
      }),
    })
    expect(resolved).toBe('https://www.deezer.com/playlist/1234567')
  })

  it('reads a canonical link when there is no meta refresh', async () => {
    const resolved = await resolveShortLink('https://link.deezer.com/s/abc', {
      transport: scriptedTransport({
        'https://link.deezer.com/s/abc': {
          body: '<html><head><link rel="canonical" href="https://www.deezer.com/playlist/7654321"></head></html>',
        },
      }),
    })
    expect(resolved).toBe('https://www.deezer.com/playlist/7654321')
  })

  it('refuses to follow a redirect outside the provider', async () => {
    const error = await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({
        'https://on.soundcloud.com/abc': { status: 302, location: 'https://evil.example/phish' },
      }),
    }).catch(value => value)
    expect(error).toBeInstanceOf(ShortLinkError)
    expect((error as ShortLinkError).kind).toBe('blocked-host')
    expect(shortLinkFailureMessage(error)).toContain('полный адрес')
  })

  it('refuses a redirect to a local address', async () => {
    const error = await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({
        'https://on.soundcloud.com/abc': { status: 302, location: 'http://127.0.0.1:8080/admin' },
      }),
    }).catch(value => value)
    expect(error).toBeInstanceOf(ShortLinkError)
    expect((error as ShortLinkError).kind).toBe('blocked-host')
  })

  it('requires https for the short link itself', async () => {
    const error = await resolveShortLink('http://on.soundcloud.com/abc', {
      transport: scriptedTransport({}),
    }).catch(value => value)
    expect((error as ShortLinkError).kind).toBe('blocked')
  })

  it('reports an unreachable shortener with a VPN hint', async () => {
    const error = await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({
        'https://on.soundcloud.com/abc': { fail: 'getaddrinfo ENOTFOUND on.soundcloud.com' },
      }),
    }).catch(value => value)
    expect((error as ShortLinkError).kind).toBe('network')
    expect(shortLinkFailureMessage(error)).toContain('VPN')
  })

  it('reports a dead shortener instead of guessing the target', async () => {
    const error = await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({ 'https://on.soundcloud.com/abc': { status: 410 } }),
    }).catch(value => value)
    expect((error as ShortLinkError).kind).toBe('blocked')
    expect(shortLinkFailureMessage(error)).toContain('410')
  })

  it('reports a page without a target address', async () => {
    const error = await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({ 'https://on.soundcloud.com/abc': { body: '<html>Загрузка…</html>' } }),
    }).catch(value => value)
    expect((error as ShortLinkError).kind).toBe('blocked')
    expect(shortLinkFailureMessage(error)).toContain('полный адрес')
  })

  it('does not treat an ordinary provider link as short', async () => {
    const error = await resolveShortLink('https://soundcloud.com/forss/sets/soulhack', {
      transport: scriptedTransport({}),
    }).catch(value => value)
    expect((error as ShortLinkError).kind).toBe('not-short')
  })

  it('returns a resolved link even when its kind is not importable', async () => {
    // The resolver only unwraps addresses; the pipeline decides what to do next.
    const resolved = await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({
        'https://on.soundcloud.com/abc': { status: 302, location: 'https://soundcloud.com/forss/soulhack' },
      }),
    })
    expect(detectImportLink(resolved)).toMatchObject({ provider: 'soundcloud', kind: 'track', supported: false })
  })

  it('identifies itself to the shortener', async () => {
    const calls: Call[] = []
    await resolveShortLink('https://on.soundcloud.com/abc', {
      transport: scriptedTransport({
        'https://on.soundcloud.com/abc': { status: 302, location: 'https://soundcloud.com/forss/sets/x' },
      }, calls),
    })
    expect(calls[0]!.userAgent).toContain('mustplay')
  })

  it('maps every supported short host to its provider', () => {
    expect(shortLinkSource('https://on.soundcloud.com/x')?.provider).toBe('soundcloud')
    expect(shortLinkSource('https://soundcloud.app.goo.gl/x')?.provider).toBe('soundcloud')
    expect(shortLinkSource('https://spotify.link/x')?.provider).toBe('spotify')
    expect(shortLinkSource('https://spoti.fi/x')?.provider).toBe('spotify')
    expect(shortLinkSource('https://link.deezer.com/x')?.provider).toBe('deezer')
    expect(shortLinkSource('https://deezer.page.link/x')?.provider).toBe('deezer')
    expect(shortLinkSource('https://youtu.be/x')?.provider).toBe('ytmusic')
    expect(shortLinkSource('https://vk.cc/x')?.provider).toBe('vk')
    expect(shortLinkSource('https://example.com/x')).toBeNull()
  })
})

describe('fetch transport', () => {
  it('keeps redirects manual and sends no credentials', async () => {
    const calls: Array<{ init: RequestInit }> = []
    const fakeFetch: typeof fetch = async (_url, init) => {
      calls.push({ init: init ?? {} })
      return new Response(null, { status: 302, headers: { location: 'https://soundcloud.com/forss/sets/x' } })
    }
    const transport = fetchTransport(fakeFetch)
    const reply = await transport.send('https://on.soundcloud.com/abc', {
      method: 'HEAD', userAgent: 'mustplay-test', timeoutMs: 1_000,
    })
    expect(reply).toMatchObject({ status: 302, location: 'https://soundcloud.com/forss/sets/x' })
    expect(calls[0]!.init).toMatchObject({ redirect: 'manual', credentials: 'omit' })
  })
})
