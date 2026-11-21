import type { AcoustidRecording, AudioCandidate, PipelineItemStatus, PipelineMethod, PipelineTrackInput } from '../shared/pipeline'
import { isrcOf, judgeFingerprint, pickCandidate } from './match'
import type { VerificationVerdict } from './match'
import { runPool } from './limiter'

export interface Fingerprint {
  durationSeconds: number
  fingerprint: string
}

export interface TrackOutcome {
  status: Extract<PipelineItemStatus, 'verified' | 'rejected' | 'failed' | 'skipped'>
  method: PipelineMethod
  confidence: number | null
  filePath: string | null
  message: string
  candidateId: string | null
  cached: boolean
}

export interface TrackDeps {
  /** Absolute path of a previously verified file for this ISRC, if it still exists. */
  cachedFile(isrc: string): Promise<string | null>
  /** Canonical metadata lookup by ISRC (Deezer / MusicBrainz). */
  resolveIsrc(isrc: string): Promise<PipelineTrackInput | null>
  /** Reference ISRC lookup by artist/title for sources that do not ship one. */
  resolveTrack?(track: PipelineTrackInput): Promise<PipelineTrackInput | null>
  search(track: PipelineTrackInput): Promise<AudioCandidate[]>
  download(candidate: AudioCandidate): Promise<string>
  fingerprint(path: string): Promise<Fingerprint>
  lookupAcoustid(input: Fingerprint): Promise<AcoustidRecording[]>
  remember(track: PipelineTrackInput, filePath: string, verdict: VerificationVerdict, fingerprint: Fingerprint): Promise<void>
  discard(filePath: string): Promise<void>
  update(status: PipelineItemStatus): void
  isCancelled(): boolean
  /** Downloads that were already tried for this item, e.g. when asking for another version. */
  excludedCandidates?: ReadonlySet<string>
  /** A retry must not stop at the cached file of a previous successful attempt. */
  useCache?: boolean
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function skipped(): TrackOutcome {
  return { status: 'skipped', method: 'none', confidence: null, filePath: null, message: 'Импорт остановлен', candidateId: null, cached: false }
}

function mergeGenres(track: PipelineTrackInput, resolved: PipelineTrackInput): string[] | undefined {
  const genres = track.genres?.length ? track.genres : resolved.genres
  return genres?.length ? genres : undefined
}

export async function runTrack(input: PipelineTrackInput, deps: TrackDeps): Promise<TrackOutcome> {
  let track: PipelineTrackInput = { ...input, isrc: isrcOf(input) }
  if (deps.isCancelled()) return skipped()

  // Sources such as Spotify's public page and YT Music do not expose an ISRC.
  // Resolve one by artist/title so the strongest check is still available.
  if (!track.isrc && deps.resolveTrack) {
    try {
      const resolved = await deps.resolveTrack(track)
      if (resolved) {
        track = {
          ...track,
          isrc: isrcOf({ ...track, isrc: resolved.isrc ?? track.isrc }),
          title: track.title || resolved.title,
          artist: track.artist ?? resolved.artist,
          album: track.album ?? resolved.album,
          genres: mergeGenres(track, resolved),
          durationSeconds: track.durationSeconds ?? resolved.durationSeconds,
        }
      }
    } catch {
      // A failing catalogue lookup must not stop the audio search.
    }
  }
  if (deps.isCancelled()) return skipped()

  if (track.isrc && deps.useCache !== false) {
    const cached = await deps.cachedFile(track.isrc)
    if (cached) {
      return { status: 'verified', method: 'isrc', confidence: 1, filePath: cached, message: 'Уже в библиотеке', candidateId: null, cached: true }
    }
  }
  if (track.isrc) {
    try {
      const resolved = await deps.resolveIsrc(track.isrc)
      if (resolved) {
        track = {
          ...track,
          title: resolved.title || track.title,
          artist: resolved.artist ?? track.artist,
          album: resolved.album ?? track.album,
          genres: mergeGenres(track, resolved),
          durationSeconds: resolved.durationSeconds ?? track.durationSeconds,
        }
      }
    } catch {
      // A failing catalogue lookup must not stop the audio search.
    }
  }

  deps.update('searching')
  let candidate: AudioCandidate | null
  if (track.sourceUrl) {
    // The source already points at the exact recording, so skip the yt-dlp search.
    candidate = {
      id: track.providerId ?? track.sourceUrl,
      url: track.sourceUrl,
      title: track.title,
      channel: track.artist,
      durationSeconds: track.durationSeconds,
    }
  } else {
    try {
      const found = await deps.search(track)
      const pool = deps.excludedCandidates?.size
        ? found.filter(item => !deps.excludedCandidates!.has(item.id))
        : found
      candidate = pickCandidate(track, pool)
    } catch (error) {
      return { status: 'failed', method: 'none', confidence: null, filePath: null, message: `Поиск не удался: ${message(error)}`, candidateId: null, cached: false }
    }
    if (!candidate) {
      return { status: 'rejected', method: 'none', confidence: null, filePath: null, message: 'Не нашли подходящую версию на YouTube', candidateId: null, cached: false }
    }
  }

  deps.update('downloading')
  let filePath: string
  try {
    filePath = await deps.download(candidate)
  } catch (error) {
    return {
      status: deps.isCancelled() ? 'skipped' : 'failed', method: 'none', confidence: null, filePath: null,
      message: `Не удалось скачать: ${message(error)}`, candidateId: candidate.id, cached: false,
    }
  }
  if (deps.isCancelled()) {
    await deps.discard(filePath).catch(() => {})
    return skipped()
  }

  deps.update('verifying')
  try {
    const fingerprint = await deps.fingerprint(filePath)
    const recordings = await deps.lookupAcoustid(fingerprint)
    const verdict = judgeFingerprint(track, recordings, fingerprint.durationSeconds)
    if (verdict.status === 'verified') {
      await deps.remember(track, filePath, verdict, fingerprint)
      return {
        status: 'verified', method: verdict.method, confidence: verdict.confidence,
        filePath, message: verdict.message, candidateId: candidate.id, cached: false,
      }
    }
    await deps.discard(filePath)
    return {
      status: 'rejected', method: 'none', confidence: verdict.confidence, filePath: null,
      message: verdict.message, candidateId: candidate.id, cached: false,
    }
  } catch (error) {
    await deps.discard(filePath).catch(() => {})
    return {
      status: 'failed', method: 'none', confidence: null, filePath: null,
      message: `Проверка не удалась: ${message(error)}`, candidateId: candidate.id, cached: false,
    }
  }
}

export async function runTracks(
  tracks: readonly PipelineTrackInput[],
  depsFor: (track: PipelineTrackInput, index: number) => TrackDeps,
  workers: number,
  onOutcome: (track: PipelineTrackInput, outcome: TrackOutcome, index: number) => void | Promise<void>,
): Promise<TrackOutcome[]> {
  return runPool(tracks, workers, async (track, index) => {
    const outcome = await runTrack(track, depsFor(track, index))
    await onOutcome(track, outcome, index)
    return outcome
  })
}
