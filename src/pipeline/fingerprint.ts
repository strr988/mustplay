import { join } from 'node:path'
import type { AcoustidRecording } from '../shared/pipeline'
import { runProcess } from '../audio/process'

const acoustidLookupUrl = 'https://api.acoustid.org/v2/lookup'

interface AcoustidResult {
  id?: string
  score?: number
  recordings?: unknown[]
}

interface AcoustidResponse {
  status?: string
  error?: { code?: number; message?: string }
  results?: AcoustidResult[]
}

interface AcoustidRecordingRaw {
  id?: string
  title?: string
  duration?: number
  artists?: unknown[]
  isrcs?: unknown[]
}

function normalizeRecording(raw: unknown): AcoustidRecording | null {
  const recording = raw as AcoustidRecordingRaw | null
  if (!recording || typeof recording.title !== 'string') return null
  const artists: string[] = []
  for (const credit of recording.artists ?? []) {
    if (credit && typeof credit === 'object' && 'name' in credit && typeof (credit as { name?: unknown }).name === 'string') {
      artists.push((credit as { name: string }).name)
    }
  }
  const isrcs: string[] = []
  for (const value of recording.isrcs ?? []) {
    if (typeof value === 'string' && value.trim()) isrcs.push(value.trim().toUpperCase())
  }
  return {
    recordingId: typeof recording.id === 'string' ? recording.id : null,
    title: recording.title.trim(),
    artist: artists.length ? artists.join(', ') : null,
    durationSeconds: typeof recording.duration === 'number' && recording.duration > 0
      ? Math.round(recording.duration) : null,
    isrcs,
    score: 0,
  }
}

export interface FingerprintInput {
  path: string
  durationSeconds: number
}

export interface FingerprintOutput {
  durationSeconds: number
  fingerprint: string
}

export interface AcoustidInput {
  durationSeconds: number
  fingerprint: string
}

/** The service answered, but refused the application key. Retrying cannot help. */
export class AcoustidKeyError extends Error {
  constructor() {
    super('AcoustID не принял ключ приложения. Проверьте ключ на acoustid.org/new-application')
    this.name = 'AcoustidKeyError'
  }
}

function acoustidError(payload: AcoustidResponse, status?: number): Error {
  const message = payload.error?.message ?? (status ? `HTTP ${status}` : 'AcoustID вернул ошибку')
  if (payload.error?.code === 4 || /invalid api key/i.test(message)) return new AcoustidKeyError()
  return new Error(`AcoustID: ${message}`)
}

export class Fingerprinter {
  constructor(private readonly fpcalc: string) {}

  async fingerprint(path: string): Promise<FingerprintOutput> {
    const { stdout } = await runProcess(this.fpcalc, [path, '-json'], { timeoutMs: 60_000 })
    let payload: { duration?: unknown; fingerprint?: unknown }
    try {
      payload = JSON.parse(stdout) as { duration?: unknown; fingerprint?: unknown }
    } catch {
      throw new Error('fpcalc не вернул JSON')
    }
    if (typeof payload.duration !== 'number' || typeof payload.fingerprint !== 'string') {
      throw new Error('fpcalc не вернул отпечаток')
    }
    return { durationSeconds: Math.round(payload.duration), fingerprint: payload.fingerprint }
  }

  async lookup(client: string, input: AcoustidInput): Promise<AcoustidRecording[]> {
    // POST keeps the (large) fingerprint out of the URL, so long tracks cannot
    // hit a request-line limit on the AcoustID side.
    const body = new URLSearchParams()
    body.set('client', client)
    body.set('fingerprint', input.fingerprint)
    body.set('duration', String(input.durationSeconds))
    // AcoustID splits `meta` on whitespace. The docs write the values with "+",
    // but that only works because a "+" in a URL query means a space; sending a
    // literal "+" is accepted silently and returns results without any metadata,
    // which looks like "no matching recording" for every track.
    body.set('meta', 'recordings isrcs')

    const response = await fetch(acoustidLookupUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    // AcoustID reports API problems (a rejected key, a broken request) as HTTP
    // 400 with a JSON body, so the body decides what the user is told.
    const text = await response.text()
    let payload: AcoustidResponse = {}
    try {
      payload = JSON.parse(text) as AcoustidResponse
    } catch {
      // Keep an empty payload for a non-JSON error page.
    }
    if (!response.ok) throw acoustidError(payload, response.status)
    if (payload.status !== 'ok') throw acoustidError(payload)

    const recordings: AcoustidRecording[] = []
    const seen = new Set<string>()
    for (const result of payload.results ?? []) {
      const score = typeof result.score === 'number' ? result.score : 0
      for (const raw of result.recordings ?? []) {
        const recording = normalizeRecording(raw)
        if (!recording) continue
        recording.score = score
        const key = recording.recordingId ?? `${recording.title}|${recording.artist ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        recordings.push(recording)
      }
    }
    return recordings
  }
}

export class DeferredFingerprinter {
  private pending: Promise<Fingerprinter> | null = null

  constructor(private readonly resolve: () => string | null) {}

  async get(): Promise<Fingerprinter> {
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => {
        const binary = this.resolve()
        if (!binary) throw new Error('Chromaprint fpcalc не найден. Установите инструменты в настройках импорта.')
        return new Fingerprinter(binary)
      })
      // Do not cache failures: the tool may be installed later in the session.
      this.pending.catch(() => { this.pending = null })
    }
    return this.pending
  }
}
