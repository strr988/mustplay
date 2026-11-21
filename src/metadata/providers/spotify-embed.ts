import type { PipelineTrackInput, ProviderPlaylist } from '../../shared/pipeline'
import { ProviderError } from './types'

const embedBase = 'https://open.spotify.com/embed/playlist/'
const browserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

interface EmbedTrack {
  uri?: unknown
  title?: unknown
  subtitle?: unknown
  duration?: unknown
  entityType?: unknown
}

interface EmbedEntity {
  type?: unknown
  name?: unknown
  title?: unknown
  trackList?: unknown
}

interface NextData {
  props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } }
}

const nextDataPattern = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

/**
 * The public embed page is offered by Spotify without an account and exposes
 * the playlist as JSON. It is a fallback for accounts that cannot use the Web
 * API (Spotify now requires Premium for new integrations).
 */
export function parseSpotifyEmbed(html: string): ProviderPlaylist | null {
  const match = nextDataPattern.exec(html)
  if (!match) return null
  let payload: NextData
  try {
    payload = JSON.parse(match[1]!) as NextData
  } catch {
    return null
  }
  const entity = payload.props?.pageProps?.state?.data?.entity
  if (!entity || !Array.isArray(entity.trackList)) return null
  const tracks: PipelineTrackInput[] = []
  for (const raw of entity.trackList as EmbedTrack[]) {
    if (!raw || typeof raw !== 'object' || raw.entityType === 'episode') continue
    if (typeof raw.title !== 'string' || !raw.title.trim()) continue
    const uri = typeof raw.uri === 'string' ? raw.uri : ''
    const spotifyTrack = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri)
    tracks.push({
      title: raw.title.trim().slice(0, 300),
      artist: typeof raw.subtitle === 'string' && raw.subtitle.trim() ? raw.subtitle.trim().slice(0, 300) : null,
      album: null,
      durationSeconds: typeof raw.duration === 'number' && raw.duration > 0 ? Math.round(raw.duration / 1000) : null,
      isrc: null,
      providerId: spotifyTrack ? spotifyTrack[1]! : null,
    })
  }
  const name = typeof entity.name === 'string' && entity.name.trim()
    ? entity.name.trim()
    : typeof entity.title === 'string' && entity.title.trim() ? entity.title.trim() : 'Плейлист Spotify'
  const note = tracks.length >= 100
    ? 'Публичная страница Spotify отдаёт первые 100 треков.'
    : null
  return { name, tracks, note }
}

export class SpotifyEmbedProvider {
  constructor(private readonly request = fetch) {}

  async fetchPlaylist(id: string): Promise<ProviderPlaylist> {
    if (!/^[A-Za-z0-9]+$/.test(id)) throw new ProviderError('spotify', 'Некорректная ссылка Spotify')
    const response = await this.request(embedBase + encodeURIComponent(id), {
      headers: { 'User-Agent': browserAgent, 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new ProviderError('spotify', `Публичная страница Spotify ответила ${response.status}`)
    const playlist = parseSpotifyEmbed(await response.text())
    if (!playlist) throw new ProviderError('spotify', 'Не удалось прочитать треки с публичной страницы Spotify')
    if (playlist.tracks.length === 0) throw new ProviderError('spotify', 'В плейлисте Spotify нет доступных треков')
    return playlist
  }
}
