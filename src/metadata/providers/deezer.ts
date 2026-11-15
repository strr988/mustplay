import type { PipelineProvider, PipelineTrackInput, ProviderPlaylist } from '../../shared/pipeline'
import { similarity } from '../../pipeline/match'
import { RateLimiter } from '../../pipeline/limiter'
import { ProviderError } from './types'
import type { MetadataProvider } from './types'

interface DeezerArtist { name?: string }
interface DeezerAlbum { title?: string }
export interface DeezerTrack {
  id?: number | string
  title?: string
  duration?: number
  isrc?: string
  artist?: DeezerArtist
  album?: DeezerAlbum
}

function trackInput(track: DeezerTrack): PipelineTrackInput | null {
  if (typeof track.title !== 'string' || !track.title.trim()) return null
  return {
    title: track.title.trim(),
    artist: typeof track.artist?.name === 'string' && track.artist.name.trim() ? track.artist.name.trim() : null,
    album: typeof track.album?.title === 'string' && track.album.title.trim() ? track.album.title.trim() : null,
    durationSeconds: typeof track.duration === 'number' && track.duration > 0 ? track.duration : null,
    isrc: typeof track.isrc === 'string' && track.isrc.trim() ? track.isrc.trim().toUpperCase() : null,
    providerId: typeof track.id === 'number' || typeof track.id === 'string' ? String(track.id) : null,
  }
}

export function parseDeezerPlaylist(payload: unknown): ProviderPlaylist {
  const playlist = payload as { title?: unknown; tracks?: { data?: unknown } }
  if (!playlist || typeof playlist !== 'object' || !Array.isArray(playlist.tracks?.data)) {
    throw new ProviderError('deezer', 'Deezer вернул неожиданный ответ')
  }
  const tracks = (playlist.tracks!.data as DeezerTrack[]).map(trackInput).filter((track): track is PipelineTrackInput => track !== null)
  return { name: typeof playlist.title === 'string' ? playlist.title : 'Плейлист Deezer', tracks }
}

export function parseDeezerTrack(payload: unknown): PipelineTrackInput | null {
  const track = payload as DeezerTrack
  return track && typeof track === 'object' ? trackInput(track) : null
}

export function parseDeezerSearch(payload: unknown): PipelineTrackInput | null {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data) || !data.length) return null
  return parseDeezerTrack(data[0])
}

/**
 * Chooses the Deezer result that best matches a track from another service.
 * Only rows that carry an ISRC are useful: the ISRC becomes the reference for
 * the AcoustID check after download.
 */
export function pickDeezerTrack(
  input: Pick<PipelineTrackInput, 'title' | 'artist' | 'durationSeconds'>,
  rows: readonly DeezerTrack[],
): PipelineTrackInput | null {
  let best: PipelineTrackInput | null = null
  let bestScore = 0
  for (const row of rows) {
    const track = trackInput(row)
    if (!track?.isrc) continue
    const title = similarity(input.title, track.title)
    if (title < 0.45) continue
    const artist = input.artist && track.artist ? similarity(input.artist, track.artist) : 0.7
    let duration = 0.6
    if (input.durationSeconds && track.durationSeconds) {
      const difference = Math.abs(input.durationSeconds - track.durationSeconds)
      duration = difference <= 8 ? 1 : difference <= 18 ? 0.5 : 0
    }
    const score = title * 0.6 + artist * 0.2 + duration * 0.2
    if (score > bestScore) {
      bestScore = score
      best = track
    }
  }
  return bestScore >= 0.6 ? best : null
}

export class DeezerProvider implements MetadataProvider {
  readonly id: PipelineProvider = 'deezer'
  readonly requiresAuth = false
  readonly providesIsrc = true

  constructor(private readonly limiter: RateLimiter, private readonly request = fetch) {}

  private async json<T>(url: string): Promise<T> {
    return this.limiter.run(async () => {
      const response = await this.request(url, { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new ProviderError('deezer', `Deezer ответил ${response.status}`)
      const payload = await response.json() as T & { error?: { message?: string } }
      if (payload && typeof payload === 'object' && payload.error) {
        throw new ProviderError('deezer', payload.error.message ?? 'Deezer вернул ошибку')
      }
      return payload
    })
  }

  async fetchPlaylist(id: string): Promise<ProviderPlaylist> {
    if (!/^\d+$/.test(id)) throw new ProviderError('deezer', 'Некорректная ссылка Deezer')
    interface Page { title?: string; tracks?: { data?: DeezerTrack[]; next?: string } }
    const first = await this.json<Page>(`https://api.deezer.com/playlist/${id}?limit=100`)
    const tracks: PipelineTrackInput[] = []
    let page: Page | undefined = first
    let guard = 0
    while (page && guard++ < 10) {
      for (const row of page.tracks?.data ?? []) {
        const track = trackInput(row)
        if (track) tracks.push(track)
      }
      const next: string | undefined = page.tracks?.next
      page = next ? await this.json<Page>(next) : undefined
    }
    return { name: typeof first.title === 'string' ? first.title : 'Плейлист Deezer', tracks }
  }

  async resolveIsrc(isrc: string): Promise<PipelineTrackInput | null> {
    const normalized = isrc.trim().toUpperCase()
    if (!/^[A-Z0-9]{12}$/.test(normalized)) return null
    const search = await this.json<unknown>(`https://api.deezer.com/search?q=isrc:${encodeURIComponent(`"${normalized}"`)}&limit=1`)
    return parseDeezerSearch(search)
  }

  /** Finds a reference ISRC for a track that came from a service without one. */
  async searchTrack(
    input: Pick<PipelineTrackInput, 'title' | 'artist' | 'durationSeconds'>,
  ): Promise<PipelineTrackInput | null> {
    const clean = (value: string) => value.replace(/["\\]/g, ' ').trim()
    const terms: string[] = []
    if (input.artist) terms.push(`artist:"${clean(input.artist)}"`)
    terms.push(`track:"${clean(input.title)}"`)
    const search = await this.json<{ data?: DeezerTrack[] }>(
      `https://api.deezer.com/search?q=${encodeURIComponent(terms.join(' '))}&limit=8`,
    )
    return pickDeezerTrack(input, Array.isArray(search.data) ? search.data : [])
  }

  async fetchIsrc(trackId: string): Promise<string | null> {
    if (!/^\d+$/.test(trackId)) return null
    const track = parseDeezerTrack(await this.json<unknown>(`https://api.deezer.com/track/${trackId}`))
    return track?.isrc ?? null
  }
}
