import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { AudioCandidate, PipelineTrackInput } from '../shared/pipeline'
import { runProcess } from './process'

export const searchLimit = 5
export const downloadTimeoutMs = 10 * 60 * 1000

/** yt-dlp failures that mean "YouTube is unreachable", not "the query is bad". */
const networkFailurePattern =
  /(INVALID_SESSION_ID|SSL|CERTIFICATE|Connection reset|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed out|getaddrinfo|Temporary failure in name resolution|urlopen error|HTTP Error 5\d\d|превышено время ожидания)/i

/** Keeps the original yt-dlp text and adds a hint the user can act on. */
export function describeYtDlpFailure(error: unknown): unknown {
  if (!(error instanceof Error) || !networkFailurePattern.test(error.message)) return error
  return new Error(`${error.message}. Похоже, YouTube недоступен из этой сети: проверьте VPN, прокси или блокировку.`)
}

export function buildSearchQuery(track: Pick<PipelineTrackInput, 'title' | 'artist'>): string {
  const artist = track.artist?.trim()
  return artist ? `${artist} - ${track.title}` : track.title
}

export function searchArguments(query: string, limit = searchLimit): string[] {
  return [
    '--ignore-config', '--no-warnings', '--skip-download', '--flat-playlist', '--dump-single-json',
    '--playlist-end', String(limit), `ytsearch${limit}:${query}`,
  ]
}

export function downloadArguments(url: string, directory: string): string[] {
  return [
    '--ignore-config', '--no-warnings', '--no-playlist', '--newline', '--no-progress',
    '--windows-filenames', '--trim-filenames', '160', '--no-overwrites',
    '-f', 'bestaudio/best',
    '-o', join(directory, '%(artist,uploader,channel)s - %(title)s [%(id)s].%(ext)s'),
    '--print', 'after_move:filepath', url,
  ]
}

interface FlatEntry {
  id?: string
  url?: string
  webpage_url?: string
  title?: string
  duration?: number | null
  channel?: string
  uploader?: string
}

export function parseSearchOutput(stdout: string): AudioCandidate[] {
  const line = stdout.trim().split('\n').findLast(value => value.trim().startsWith('{'))
  if (!line) return []
  let payload: { entries?: unknown }
  try {
    payload = JSON.parse(line) as { entries?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(payload.entries)) return []
  const candidates: AudioCandidate[] = []
  for (const raw of payload.entries as (FlatEntry | null)[]) {
    if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) continue
    const webUrl = typeof raw.webpage_url === 'string' && raw.webpage_url
      ? raw.webpage_url
      : typeof raw.url === 'string' && /^https?:/i.test(raw.url) ? raw.url
        : typeof raw.id === 'string' ? `https://www.youtube.com/watch?v=${raw.id}` : null
    if (!webUrl) continue
    candidates.push({
      id: typeof raw.id === 'string' ? raw.id : webUrl,
      url: webUrl,
      title: raw.title.trim(),
      channel: raw.uploader?.trim() || raw.channel?.trim() || null,
      durationSeconds: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : null,
    })
  }
  return candidates
}

export function parseDownloadedPath(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (/^[A-Za-z]:\\/.test(line) && extname(line)) return line
    if (line.startsWith('/') && extname(line)) return line
  }
  return null
}

export class YtDlp {
  constructor(private readonly binary: string) {}

  async search(track: Pick<PipelineTrackInput, 'title' | 'artist'>, signal?: AbortSignal): Promise<AudioCandidate[]> {
    try {
      const { stdout } = await runProcess(this.binary, searchArguments(buildSearchQuery(track)), { timeoutMs: 60_000, signal })
      return parseSearchOutput(stdout)
    } catch (error) {
      if (signal?.aborted) throw error
      throw describeYtDlpFailure(error)
    }
  }

  async download(candidate: AudioCandidate, directory: string, signal?: AbortSignal): Promise<string> {
    await mkdir(directory, { recursive: true })
    let stdout: string
    try {
      ({ stdout } = await runProcess(this.binary, downloadArguments(candidate.url, directory), {
        timeoutMs: downloadTimeoutMs, signal,
      }))
    } catch (error) {
      if (signal?.aborted) throw error
      throw describeYtDlpFailure(error)
    }
    const path = parseDownloadedPath(stdout)
    if (!path) throw new Error('yt-dlp не сообщил путь к файлу')
    return path
  }

  async version(): Promise<string> {
    const { stdout } = await runProcess(this.binary, ['--version'], { timeoutMs: 20_000 })
    return stdout.trim()
  }
}
