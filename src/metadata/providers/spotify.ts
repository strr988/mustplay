import { createHash, randomBytes } from 'node:crypto'
import type { PipelineProvider, PipelineTrackInput, ProviderPlaylist } from '../../shared/pipeline'
import { RateLimiter } from '../../pipeline/limiter'
import { ProviderError } from './types'
import type { MetadataProvider } from './types'

export const spotifyScopes = ['playlist-read-private', 'playlist-read-collaborative'] as const
export const spotifyRedirectUri = 'http://127.0.0.1:8888/callback'

export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function spotifyAuthorizationUrl(clientId: string, verifier: string, state: string): string {
  const url = new URL('https://accounts.spotify.com/authorize')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', spotifyRedirectUri)
  url.searchParams.set('scope', spotifyScopes.join(' '))
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('code_challenge', codeChallenge(verifier))
  url.searchParams.set('state', state)
  return url.toString()
}

interface SpotifyArtist { name?: string }
interface SpotifyTrack {
  id?: string
  name?: string
  duration_ms?: number
  external_ids?: { isrc?: string }
  artists?: SpotifyArtist[]
  album?: { name?: string }
  type?: string
}
interface SpotifyItem { track?: SpotifyTrack | null }
export interface SpotifyPage { name?: string; next?: string | null; items?: SpotifyItem[] }

function trackInput(track: SpotifyTrack): PipelineTrackInput | null {
  if (typeof track.name !== 'string' || !track.name.trim()) return null
  const artists = (track.artists ?? []).map(artist => artist.name?.trim()).filter((name): name is string => !!name)
  return {
    title: track.name.trim(),
    artist: artists.length ? artists.join(', ') : null,
    album: typeof track.album?.name === 'string' && track.album.name.trim() ? track.album.name.trim() : null,
    durationSeconds: typeof track.duration_ms === 'number' && track.duration_ms > 0 ? Math.round(track.duration_ms / 1000) : null,
    isrc: typeof track.external_ids?.isrc === 'string' && track.external_ids.isrc.trim()
      ? track.external_ids.isrc.trim().toUpperCase() : null,
    providerId: typeof track.id === 'string' ? track.id : null,
  }
}

export function parseSpotifyPage(payload: unknown): { name: string; tracks: PipelineTrackInput[]; next: string | null } {
  const page = payload as SpotifyPage
  if (!page || typeof page !== 'object' || !Array.isArray(page.items)) {
    throw new ProviderError('spotify', 'Spotify вернул неожиданный ответ')
  }
  const tracks = page.items
    .map(item => item?.track)
    .filter((track): track is SpotifyTrack => !!track && track.type !== 'episode')
    .map(trackInput)
    .filter((track): track is PipelineTrackInput => track !== null)
  return {
    name: typeof page.name === 'string' ? page.name : 'Плейлист Spotify',
    tracks,
    next: typeof page.next === 'string' && page.next ? page.next : null,
  }
}

export class SpotifyProvider implements MetadataProvider {
  readonly id: PipelineProvider = 'spotify'
  readonly requiresAuth = true
  readonly providesIsrc = true

  constructor(
    private readonly token: () => Promise<string>,
    private readonly limiter: RateLimiter,
    private readonly request = fetch,
  ) {}

  private async json<T>(url: string): Promise<T> {
    return this.limiter.run(async () => {
      const response = await this.request(url, {
        headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' },
      })
      if (response.status === 401) throw new ProviderError('spotify', 'Spotify отклонил токен, подключите аккаунт заново')
      if (!response.ok) throw new ProviderError('spotify', `Spotify ответил ${response.status}`)
      return await response.json() as T
    })
  }

  async fetchPlaylist(id: string): Promise<ProviderPlaylist> {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw new ProviderError('spotify', 'Некорректная ссылка Spotify')
    const fields = 'name,next,items(track(id,name,type,duration_ms,external_ids,artists(name),album(name)))'
    let url: string | null = `https://api.spotify.com/v1/playlists/${id}?fields=${encodeURIComponent(fields)}&limit=100`
    const tracks: PipelineTrackInput[] = []
    let name = 'Плейлист Spotify'
    let guard = 0
    while (url && guard++ < 10) {
      const page = parseSpotifyPage(await this.json<unknown>(url))
      if (tracks.length === 0) name = page.name
      tracks.push(...page.tracks)
      url = page.next
    }
    return { name, tracks }
  }
}
