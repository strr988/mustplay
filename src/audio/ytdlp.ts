import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { AudioCandidate, PipelineTrackInput } from '../shared/pipeline'
import { runProcess } from './process'

export const searchLimit = 5
export const downloadTimeoutMs = 10 * 60 * 1000

/** yt-dlp failures that mean "YouTube is unreachable", not "the query is bad". */
const networkFailurePattern =
  /(INVALID_SESSION_ID|SSL|CERTIFICATE|Connection reset|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed out|getaddrinfo|Temporary failure in name resolution|urlopen error|HTTP Error 5\d\d|превышено время ожидания)/i

/**
 * SoundCloud now serves label tracks only through its own player and marks them
 * "DRM protected". Nothing can be downloaded from those pages, so the message
 * has to say that instead of showing a raw yt-dlp error.
 */
const drmFailurePattern = /DRM protected/i

/** Keeps the original yt-dlp text and adds a hint the user can act on. */
export function describeYtDlpFailure(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (drmFailurePattern.test(error.message)) {
    return new Error('Трек защищён DRM в источнике: сервис не разрешает скачивание этой записи. Попробуйте другую версию или другой источник.')
  }
  if (!networkFailurePattern.test(error.message)) return error
  return new Error(`${error.message}. Похоже, источник недоступен из этой сети: проверьте VPN, прокси или блокировку.`)
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

export type DownloadFormat = 'm4a' | 'original'

/**
 * m4a plays on phones and car stereos, which plain webm/opus often does not.
 * yt-dlp can mux to m4a without ffmpeg when the source already has AAC, so
 * this stays a zero-install choice.
 */
export function audioSelector(format: DownloadFormat): string {
  return format === 'm4a' ? 'bestaudio[ext=m4a]/bestaudio/best' : 'bestaudio/best'
}

export function downloadArguments(url: string, directory: string, format: DownloadFormat = 'original'): string[] {
  return [
    '--ignore-config', '--no-warnings', '--no-playlist', '--newline', '--no-progress',
    '--windows-filenames', '--trim-filenames', '160', '--no-overwrites',
    '-f', audioSelector(format),
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

export interface PlaylistOptions {
  /**
   * Flat mode is fast, but some services (SoundCloud sets) omit titles and
   * page URLs. Full mode resolves every entry, which is slower but correct.
   */
  flat?: boolean
  limit?: number
}

export function playlistArguments(
  url: string,
  cookiesPath: string | null,
  options: PlaylistOptions = {},
): string[] {
  const flat = options.flat !== false
  return [
    '--ignore-config', '--no-warnings',
    // One broken entry must not throw away the whole list.
    ...(flat ? ['--flat-playlist'] : ['--ignore-errors']),
    '--dump-single-json',
    '--playlist-end', String(options.limit ?? 500),
    ...(cookiesPath ? ['--cookies', cookiesPath] : []),
    url,
  ]
}

interface PlaylistEntry extends FlatEntry {
  webpage_url?: string
  album_artist?: string
}

/**
 * SoundCloud sets expose each track as a bare URL without a title. The slug is
 * the only readable name we get without asking SoundCloud one request per track.
 */
function titleFromUrl(url: string): string {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    const words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : ''
  } catch {
    return ''
  }
}

/**
 * Converts yt-dlp's flat playlist JSON into our track list. SoundCloud, VK and
 * similar services usually know the exact recording, so `sourceUrl` lets the
 * pipeline skip the YouTube search and download from the original service.
 */
export function parsePlaylistOutput(stdout: string): { name: string | null; tracks: PipelineTrackInput[] } | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  let payload: { title?: unknown; entries?: unknown }
  try {
    payload = JSON.parse(trimmed) as { title?: unknown; entries?: unknown }
  } catch {
    return null
  }
  if (!Array.isArray(payload.entries)) return null
  const tracks: PipelineTrackInput[] = []
  for (const raw of payload.entries as (PlaylistEntry | null)[]) {
    if (!raw) continue
    const webUrl = typeof raw.webpage_url === 'string' && /^https?:/i.test(raw.webpage_url)
      ? raw.webpage_url
      : typeof raw.url === 'string' && /^https?:/i.test(raw.url) ? raw.url : null
    let title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (!title && webUrl) title = titleFromUrl(webUrl)
    if (!webUrl || !title) continue
    let artist = raw.uploader?.trim() || raw.channel?.trim() || raw.album_artist?.trim() || null
    if (!artist && title.includes(' - ')) {
      const [left, ...rest] = title.split(' - ')
      if (left.trim() && rest.join(' - ').trim()) {
        artist = left.trim()
        title = rest.join(' - ').trim()
      }
    }
    tracks.push({
      title: title.slice(0, 300),
      artist,
      album: null,
      durationSeconds: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : null,
      isrc: null,
      providerId: typeof raw.id === 'string' ? raw.id : null,
      sourceUrl: webUrl,
    })
  }
  return {
    name: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : null,
    tracks,
  }
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

  /** Reads a public playlist page without a browser session. */
  async playlist(
    url: string,
    cookiesPath: string | null = null,
    signal?: AbortSignal,
    options: PlaylistOptions & { timeoutMs?: number } = {},
  ): Promise<{ name: string | null; tracks: PipelineTrackInput[] }> {
    let stdout: string
    try {
      ({ stdout } = await runProcess(this.binary, playlistArguments(url, cookiesPath, options), {
        timeoutMs: options.timeoutMs ?? 3 * 60_000, signal,
      }))
    } catch (error) {
      if (signal?.aborted) throw error
      throw describeYtDlpFailure(error)
    }
    const parsed = parsePlaylistOutput(stdout)
    if (!parsed) throw new Error('Не удалось разобрать список треков из ответа yt-dlp')
    return parsed
  }

  async download(candidate: AudioCandidate, directory: string, signal?: AbortSignal, format: DownloadFormat = 'original'): Promise<string> {
    await mkdir(directory, { recursive: true })
    let stdout: string
    try {
      ({ stdout } = await runProcess(this.binary, downloadArguments(candidate.url, directory, format), {
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
