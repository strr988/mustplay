import type { AcoustidRecording, AudioCandidate, PipelineMethod, PipelineTrackInput } from '../shared/pipeline'

const noise = new Set([
  'the', 'a', 'an', 'and', 'feat', 'ft', 'featuring', 'with', 'prod', 'remaster', 'remastered',
  'version', 'edit', 'mix', 'live', 'official', 'audio', 'video', 'lyrics', 'explicit', 'bonus',
])

export function normalize(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^0-9a-z\u0400-\u04ff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(value: string | null | undefined): string[] {
  return normalize(value).split(' ').filter(token => token && !noise.has(token))
}

/** Share of the reference tokens that also occur in the candidate. */
export function similarity(reference: string | null | undefined, candidate: string | null | undefined): number {
  const left = new Set(tokenize(reference))
  const right = new Set(tokenize(candidate))
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / left.size
}

export function metadataSimilarity(track: Pick<PipelineTrackInput, 'title' | 'artist'>, candidate: { title: string; artist?: string | null }): number {
  const title = similarity(track.title, candidate.title)
  if (!track.artist || !candidate.artist) return title * 0.85
  return title * 0.65 + similarity(track.artist, candidate.artist) * 0.35
}

function durationScore(expected: number | null, actual: number | null): number {
  if (expected === null || actual === null) return 0.7
  const difference = Math.abs(expected - actual)
  if (difference <= 4) return 1
  if (difference <= 10) return 0.75
  if (difference <= 20) return 0.4
  return 0
}

export function candidateScore(track: PipelineTrackInput, candidate: AudioCandidate): number {
  // yt-dlp titles usually carry both the artist and the title, so compare against both.
  const text = similarity(`${track.artist ?? ''} ${track.title}`, candidate.title) * 0.7 +
    similarity(track.title, candidate.title) * 0.3
  return text * 0.75 + durationScore(track.durationSeconds, candidate.durationSeconds) * 0.25
}

export const candidateThreshold = 0.34

/**
 * How far a candidate's length may drift from the reference before it is
 * treated as a different recording. YouTube is full of edits, live takes and
 * short uploads that still carry the right title.
 */
export function durationTolerance(durationSeconds: number | null | undefined): number | null {
  if (durationSeconds === null || durationSeconds === undefined || !Number.isFinite(durationSeconds)) return null
  return Math.max(20, durationSeconds * 0.15)
}

export function pickCandidate(track: PipelineTrackInput, candidates: readonly AudioCandidate[]): AudioCandidate | null {
  const tolerance = durationTolerance(track.durationSeconds)
  // Prefer uploads whose length fits the reference when the length is known.
  // Text alone lets a well-named three-minute edit beat the real track.
  const fitting = tolerance === null || track.durationSeconds === null
    ? candidates
    : candidates.filter(candidate => candidate.durationSeconds === null ||
      Math.abs(candidate.durationSeconds - track.durationSeconds!) <= tolerance)
  const pool = fitting.length ? fitting : candidates
  let best: AudioCandidate | null = null
  let bestScore = 0
  for (const candidate of pool) {
    const score = candidateScore(track, candidate)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best && bestScore >= candidateThreshold ? best : null
}

export interface VerificationVerdict {
  status: 'verified' | 'rejected'
  method: PipelineMethod
  confidence: number
  message: string
}

function normalizeIsrc(value: string): string {
  return value.replace(/[^0-9a-z]/gi, '').toUpperCase()
}

export function judgeFingerprint(
  track: PipelineTrackInput,
  recordings: readonly AcoustidRecording[],
  downloadedDuration: number,
): VerificationVerdict {
  if (!recordings.length) {
    return { status: 'rejected', method: 'none', confidence: 0, message: 'Не удалось распознать запись. Возможно, на YouTube другая версия.' }
  }
  let best: AcoustidRecording | null = null
  let bestConfidence = -1
  for (const recording of recordings) {
    const meta = metadataSimilarity(track, { title: recording.title, artist: recording.artist })
    const duration = durationScore(track.durationSeconds ?? downloadedDuration, recording.durationSeconds ?? downloadedDuration)
    const confidence = recording.score * 0.5 + meta * 0.4 + duration * 0.1
    if (confidence > bestConfidence) {
      bestConfidence = confidence
      best = recording
    }
  }
  if (!best) return { status: 'rejected', method: 'none', confidence: 0, message: 'Не удалось распознать запись. Возможно, на YouTube другая версия.' }

  const expectedIsrc = track.isrc ? normalizeIsrc(track.isrc) : null
  const isrcMatch = expectedIsrc !== null && best.isrcs.some(isrc => normalizeIsrc(isrc) === expectedIsrc)
  const confidence = Math.round(Math.max(0, Math.min(1, bestConfidence)) * 100) / 100
  if (isrcMatch) {
    return { status: 'verified', method: 'isrc', confidence, message: 'Совпал код трека' }
  }
  if (confidence >= 0.55 && best.score >= 0.5) {
    return { status: 'verified', method: 'acoustid', confidence, message: 'Совпал отпечаток записи' }
  }
  return {
    status: 'rejected', method: 'none', confidence,
    message: 'На YouTube нашлась другая версия — не смогли подтвердить, что это тот же трек.',
  }
}

export function isrcOf(track: PipelineTrackInput): string | null {
  const value = track.isrc?.trim().toUpperCase()
  return value && /^[A-Z0-9]{12}$/.test(value) ? value : null
}
