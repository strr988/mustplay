import type { PipelineTrackInput } from '../shared/pipeline'
import { RateLimiter } from '../pipeline/limiter'
import { similarity } from '../pipeline/match'

const userAgent = 'mustplay/0.9.0 ( https://github.com/strr988/mustplay )'

interface MusicBrainzRecording {
  id?: string
  title?: string
  score?: number
  length?: number
  isrcs?: string[]
  genres?: { name?: string; count?: number }[]
  tags?: { name?: string; count?: number }[]
  'artist-credit'?: { name?: string }[]
}

/**
 * MusicBrainz keeps curated genres and free-form tags. Genres are preferred;
 * when a recording has none, the most used tags still give the wave something
 * to work with.
 */
export function musicBrainzGenres(recording: MusicBrainzRecording): string[] {
  const names = (values: { name?: string }[] | undefined) => (values ?? [])
    .map(value => typeof value.name === 'string' ? value.name.trim() : '')
    .filter(Boolean)
  const genres = names(recording.genres)
  if (genres.length) return genres.slice(0, 5)
  return (recording.tags ?? [])
    .filter(tag => typeof tag.name === 'string' && tag.name.trim() && (tag.count ?? 0) >= 1)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map(tag => tag.name!.trim())
    .slice(0, 3)
}

export function parseIsrcLookup(payload: unknown, isrc: string): PipelineTrackInput | null {
  const recordings = (payload as { recordings?: unknown })?.recordings
  if (!Array.isArray(recordings)) return null
  const wanted = isrc.toUpperCase()
  const candidates = (recordings as MusicBrainzRecording[]).filter(recording =>
    typeof recording.title === 'string' && recording.title.trim() &&
    Array.isArray(recording.isrcs) && recording.isrcs.some(value => value.toUpperCase() === wanted))
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const best = candidates[0]
  if (!best) return null
  const artists = (best['artist-credit'] ?? []).map(credit => credit.name?.trim()).filter((name): name is string => !!name)
  return {
    title: best.title!.trim(),
    artist: artists.length ? artists.join(', ') : null,
    album: null,
    durationSeconds: typeof best.length === 'number' && best.length > 0 ? Math.round(best.length / 1000) : null,
    isrc: wanted,
    genres: musicBrainzGenres(best),
    providerId: typeof best.id === 'string' ? best.id : null,
  }
}

function toTrack(recording: MusicBrainzRecording, isrc: string): PipelineTrackInput {
  const artists = (recording['artist-credit'] ?? []).map(credit => credit.name?.trim()).filter((name): name is string => !!name)
  return {
    title: recording.title!.trim(),
    artist: artists.length ? artists.join(', ') : null,
    album: null,
    durationSeconds: typeof recording.length === 'number' && recording.length > 0 ? Math.round(recording.length / 1000) : null,
    isrc: isrc.toUpperCase(),
    genres: musicBrainzGenres(recording),
    providerId: typeof recording.id === 'string' ? recording.id : null,
  }
}

/** Ranks search results for a track that came from a service without ISRC. */
export function rankMusicBrainzCandidates(
  input: Pick<PipelineTrackInput, 'title' | 'artist' | 'durationSeconds'>,
  payload: unknown,
): MusicBrainzRecording[] {
  const recordings = (payload as { recordings?: unknown })?.recordings
  if (!Array.isArray(recordings)) return []
  return (recordings as MusicBrainzRecording[])
    .filter(recording => typeof recording.title === 'string' && recording.title.trim())
    .map(recording => {
      const title = similarity(input.title, recording.title)
      const artist = input.artist
        ? similarity(input.artist, (recording['artist-credit'] ?? []).map(credit => credit.name).join(', '))
        : 0.7
      const duration = input.durationSeconds && recording.length
        ? Math.abs(input.durationSeconds - Math.round(recording.length / 1000)) <= 15 ? 1 : 0.2
        : 0.6
      return { recording, score: title * 0.6 + artist * 0.25 + duration * 0.15 }
    })
    .filter(item => item.score >= 0.62)
    .sort((a, b) => b.score - a.score)
    .map(item => item.recording)
}

export class MusicBrainzLookup {
  constructor(private readonly limiter: RateLimiter, private readonly request = fetch) {}

  private async json<T>(url: string): Promise<T | null> {
    return this.limiter.run(async () => {
      const response = await this.request(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } })
      return response.ok ? await response.json() as T : null
    })
  }

  async resolveIsrc(isrc: string): Promise<PipelineTrackInput | null> {
    const normalized = isrc.trim().toUpperCase()
    if (!/^[A-Z0-9]{12}$/.test(normalized)) return null
    return this.limiter.run(async () => {
      const url = `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(normalized)}?fmt=json&inc=recordings+artist-credits+genres+tags`
      const response = await this.request(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } })
      if (!response.ok) return null
      return parseIsrcLookup(await response.json(), normalized)
    })
  }

  /** Finds a reference ISRC by artist/title when the source service omitted it. */
  async searchTrack(
    input: Pick<PipelineTrackInput, 'title' | 'artist' | 'durationSeconds'>,
  ): Promise<PipelineTrackInput | null> {
    const terms: string[] = []
    const clean = (value: string) => value.replace(/["\\]/g, ' ').trim()
    terms.push(`recording:"${clean(input.title)}"`)
    if (input.artist) terms.push(`artist:"${clean(input.artist)}"`)
    const query = encodeURIComponent(terms.join(' AND '))
    const search = await this.json<unknown>(`https://musicbrainz.org/ws/2/recording?query=${query}&fmt=json&limit=8`)
    if (!search) return null
    for (const candidate of rankMusicBrainzCandidates(input, search).slice(0, 2)) {
      if (typeof candidate.id !== 'string') continue
      const lookup = await this.json<MusicBrainzRecording>(
        `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(candidate.id)}?inc=isrcs+artist-credits+genres+tags&fmt=json`,
      )
      const isrc = lookup?.isrcs?.find(value => typeof value === 'string' && /^[A-Z0-9]{12}$/i.test(value))
      if (isrc) return toTrack(lookup!, isrc)
    }
    return null
  }
}
