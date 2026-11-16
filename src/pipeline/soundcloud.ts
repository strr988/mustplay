import type { PipelineTrackInput } from '../shared/pipeline'
import { isDrmFailure, isNetworkFailure } from '../audio/ytdlp'

/**
 * SoundCloud sets are fragile in a specific way: a single SoundCloud Go+ record
 * is marked "DRM protected" and yt-dlp aborts the whole full read before it
 * prints any JSON. Losing the other thirty tracks because of one label record
 * is unacceptable, so the set is read in two phases.
 *
 * Phase 1 is the old fast path: one `--dump-single-json` call that resolves
 * every entry. It works for the vast majority of sets.
 *
 * Phase 2 is the fallback: read the list flat (flat never touches individual
 * records, so DRM cannot abort it), then resolve each record on its own with a
 * small worker pool. A failure is isolated to that record and counted, never
 * escalated to "the whole set failed".
 */

export interface SoundCloudReader {
  playlist(
    url: string,
    options?: { flat?: boolean; limit?: number },
  ): Promise<{ name: string | null; tracks: PipelineTrackInput[]; expectedCount?: number; skippedDrm?: boolean }>
  track(url: string): Promise<PipelineTrackInput | null>
}

export interface SoundCloudReadResult {
  name: string | null
  tracks: PipelineTrackInput[]
  /** Records the service declared but did not give us a playable page for. */
  skipped: number
  /** Records SoundCloud explicitly refused outside its own player. */
  skippedDrm: number
  /** Records that failed for another reason: 404, region lock, bad page. */
  skippedOther: number
  note: string
}

export interface SoundCloudReadOptions {
  /** Entries the full read asks yt-dlp for. */
  limit?: number
  /** Per-record resolutions running at once in phase 2. */
  concurrency?: number
}

export const soundCloudConcurrency = 4

export async function readSoundCloudSet(
  url: string,
  reader: SoundCloudReader,
  options: SoundCloudReadOptions = {},
): Promise<SoundCloudReadResult> {
  const limit = options.limit ?? 100
  const concurrency = Math.max(1, options.concurrency ?? soundCloudConcurrency)

  let full: {
    name: string | null
    tracks: PipelineTrackInput[]
    expectedCount?: number
    skippedDrm?: boolean
  } | null = null
  try {
    full = await reader.playlist(url, { flat: false, limit })
  } catch (error) {
    // An unreachable service must fail loudly: the flat fallback cannot reach
    // it either, and a quiet "0 tracks" would hide a VPN problem.
    if (!isDrmFailure(error) && isNetworkFailure(error)) throw error
  }

  if (full?.tracks.length) {
    // yt-dlp with --ignore-errors still prints the readable entries, but the
    // failed ones are missing from `entries`. `playlist_count` tells the truth.
    const declared = Math.max(full.expectedCount ?? full.tracks.length, full.tracks.length)
    const skipped = declared - full.tracks.length
    return {
      name: full.name,
      tracks: full.tracks,
      skipped,
      skippedDrm: full.skippedDrm ? skipped : 0,
      skippedOther: full.skippedDrm ? 0 : skipped,
      note: skipped
        ? `Публичная страница SoundCloud: ${full.tracks.length} из ${declared} треков, ${skipped} пропущено (${full.skippedDrm ? 'DRM' : 'ошибка записи'}).`
        : `Публичная страница SoundCloud: ${full.tracks.length} ${tracksWord(full.tracks.length)}.`,
    }
  }

  const flat = await reader.playlist(url, { flat: true, limit: options.limit ?? 500 })
  if (!flat.tracks.length) throw new Error('В сете не нашлось треков')

  const resolved: Array<PipelineTrackInput | null> = new Array(flat.tracks.length).fill(null)
  let skippedDrm = 0
  let skippedOther = 0
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++
      if (index >= flat.tracks.length) return
      const entry = flat.tracks[index]!
      const target = entry.sourceUrl
      if (!target) {
        skippedOther++
        continue
      }
      try {
        const track = await reader.track(target)
        if (!track) {
          skippedOther++
          continue
        }
        resolved[index] = mergeTrack(entry, track, target)
      } catch (error) {
        if (isDrmFailure(error)) skippedDrm++
        else skippedOther++
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, flat.tracks.length) }, worker))

  const tracks = resolved.filter((track): track is PipelineTrackInput => track !== null)
  const total = Math.max(flat.expectedCount ?? flat.tracks.length, flat.tracks.length)
  if (!tracks.length) {
    if (skippedDrm > 0) {
      throw new Error('Импортировать этот сет нельзя: все треки защищены DRM, SoundCloud не разрешает их скачивание.')
    }
    throw new Error(`Не удалось прочитать ни один из ${total} треков сета. Проверьте, что сет открыт, и повторите.`)
  }

  const skipped = total - tracks.length
  const details = [
    skippedDrm ? `${skippedDrm} пропущено (DRM)` : '',
    skippedOther ? `${skippedOther} не удалось прочитать` : '',
  ].filter(Boolean).join(', ')
  return {
    name: flat.name,
    tracks,
    skipped,
    skippedDrm,
    skippedOther,
    note: skipped
      ? `Публичная страница SoundCloud: ${tracks.length} из ${total} треков, ${details}.`
      : `Публичная страница SoundCloud: ${tracks.length} ${tracksWord(tracks.length)}.`,
  }
}

function tracksWord(count: number): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return 'трек'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'трека'
  return 'треков'
}

/** A resolved page is richer than a flat entry, but it may omit fields. */
function mergeTrack(
  entry: PipelineTrackInput,
  track: PipelineTrackInput,
  sourceUrl: string,
): PipelineTrackInput {
  return {
    title: track.title || entry.title,
    artist: track.artist ?? entry.artist,
    album: track.album ?? entry.album,
    durationSeconds: track.durationSeconds ?? entry.durationSeconds,
    isrc: track.isrc ?? entry.isrc,
    genres: track.genres ?? entry.genres,
    providerId: track.providerId ?? entry.providerId,
    sourceUrl: track.sourceUrl ?? sourceUrl,
  }
}

/**
 * The full read can also fail without a DRM marker: yt-dlp may reject the
 * wrapper page, a single entry may 404, or it may print a short read. The flat
 * fallback is cheap and can still succeed, so only a network failure aborts.
 */
