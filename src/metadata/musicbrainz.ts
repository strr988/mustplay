import type { PipelineTrackInput } from '../shared/pipeline'
import { RateLimiter } from '../pipeline/limiter'

const userAgent = 'mustplay/0.9.0 ( https://github.com/strr988/mustplay )'

interface MusicBrainzRecording {
  id?: string
  title?: string
  score?: number
  length?: number
  isrcs?: string[]
  'artist-credit'?: { name?: string }[]
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
    providerId: typeof best.id === 'string' ? best.id : null,
  }
}

export class MusicBrainzLookup {
  constructor(private readonly limiter: RateLimiter, private readonly request = fetch) {}

  async resolveIsrc(isrc: string): Promise<PipelineTrackInput | null> {
    const normalized = isrc.trim().toUpperCase()
    if (!/^[A-Z0-9]{12}$/.test(normalized)) return null
    return this.limiter.run(async () => {
      const url = `https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(normalized)}?fmt=json&inc=recordings+artist-credits`
      const response = await this.request(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' } })
      if (!response.ok) return null
      return parseIsrcLookup(await response.json(), normalized)
    })
  }
}
