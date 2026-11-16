import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { AudioCandidate, PipelineTrackInput } from '../shared/pipeline'
import type { ProcessResult } from './process'
import { runProcess, ProcessError } from './process'

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
const drmFailurePattern = /DRM protected|защищён DRM/i

/** Host of a source URL, so the message can name what failed to connect. */
function sourceHost(sourceUrl?: string): string | null {
  if (!sourceUrl) return null
  try {
    return new URL(sourceUrl).hostname || null
  } catch {
    return null
  }
}

/** Keeps the original yt-dlp text and adds a hint the user can act on. */
export function describeYtDlpFailure(error: unknown, sourceUrl?: string): unknown {
  if (!(error instanceof Error)) return error
  if (isDrmFailure(error)) {
    return new Error('Трек защищён DRM в источнике: сервис не разрешает скачивание этой записи. Попробуйте другую версию или другой источник.')
  }
  if (!isNetworkFailure(error)) return error
  const host = sourceHost(sourceUrl)
  const where = host ? ` Соединение с ${host} оборвалось.` : ''
  return new Error(`${error.message}. Похоже, источник недоступен из этой сети: проверьте VPN, прокси или блокировку.${where}`)
}

/** yt-dlp flag that pins connections to IPv4. */
export const forceIpv4Flag = '--force-ipv4'

/**
 * Retry arguments that avoid a broken IPv6 route. Some tunnels advertise IPv6
 * but drop TLS to it, while the same host answers over IPv4.
 */
export function forceIpv4Arguments(args: readonly string[]): string[] {
  if (args.includes(forceIpv4Flag)) return [...args]
  if (!args.length) return [forceIpv4Flag]
  return [args[0]!, forceIpv4Flag, ...args.slice(1)]
}

/**
 * Runs yt-dlp and retries a failed handshake over IPv4. Tunnels that flap fail
 * twice in a row, hence two retries; a query error is never retried.
 */
export async function runYtDlp(
  binary: string,
  args: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<ProcessResult> {
  const ipv4 = forceIpv4Arguments(args)
  const attempts = [args, ipv4, ipv4]
  let lastError: unknown
  for (const [index, attempt] of attempts.entries()) {
    try {
      return await runProcess(binary, attempt, options)
    } catch (error) {
      lastError = error
      if (options.signal?.aborted) throw error
      // A null code is our own timeout; retrying would only double the wait.
      if (!(error instanceof ProcessError) || error.code === null) throw error
      if (!isNetworkFailure(error)) throw error
      if (index < attempts.length - 1) await new Promise(resolve => setTimeout(resolve, 800))
    }
  }
  throw lastError
}

function errorText(error: Error): string {
  return error instanceof ProcessError ? `${error.message}\n${error.stderr}\n${error.stdout}` : error.message
}

/** True for a single record SoundCloud refuses to serve outside its own player. */
export function isDrmFailure(error: unknown): boolean {
  return error instanceof Error && drmFailurePattern.test(errorText(error))
}

/** True when the service itself is unreachable, as opposed to one bad record. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof Error && networkFailurePattern.test(errorText(error))
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

/**
 * One track page, fully resolved. Used to enrich a flat SoundCloud set after
 * the fast full read failed on a DRM-protected entry.
 */
export function trackArguments(url: string): string[] {
  return ['--ignore-config', '--no-warnings', '--no-playlist', '--dump-single-json', url]
}

interface PlaylistEntry extends FlatEntry {
  webpage_url?: string
  album_artist?: string
  album?: string
  genre?: string
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

/** Converts one yt-dlp entry (flat or fully resolved) into a track. */
function entryToTrack(raw: PlaylistEntry): PipelineTrackInput | null {
  const webUrl = typeof raw.webpage_url === 'string' && /^https?:/i.test(raw.webpage_url)
    ? raw.webpage_url
    : typeof raw.url === 'string' && /^https?:/i.test(raw.url) ? raw.url : null
  if (!webUrl) return null
  let title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) title = titleFromUrl(webUrl)
  if (!title) return null
  let artist = raw.uploader?.trim() || raw.channel?.trim() || raw.album_artist?.trim() || null
  if (!artist && title.includes(' - ')) {
    const [left, ...rest] = title.split(' - ')
    if (left.trim() && rest.join(' - ').trim()) {
      artist = left.trim()
      title = rest.join(' - ').trim()
    }
  }
  const genres = typeof raw.genre === 'string' && raw.genre.trim() ? [raw.genre.trim()] : undefined
  return {
    title: title.slice(0, 300),
    artist,
    album: typeof raw.album === 'string' && raw.album.trim() ? raw.album.trim() : null,
    durationSeconds: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : null,
    isrc: null,
    ...(genres ? { genres } : {}),
    providerId: typeof raw.id === 'string' ? raw.id : null,
    sourceUrl: webUrl,
  }
}

/**
 * Converts yt-dlp's flat playlist JSON into our track list. SoundCloud, VK and
 * similar services usually know the exact recording, so `sourceUrl` lets the
 * pipeline skip the YouTube search and download from the original service.
 */
export function parsePlaylistOutput(stdout: string): {
  name: string | null
  tracks: PipelineTrackInput[]
  /** Entries the service declared, including ones yt-dlp skipped. */
  expectedCount: number
} | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  let payload: { title?: unknown; entries?: unknown; playlist_count?: unknown; n_entries?: unknown } | null
  try {
    payload = JSON.parse(trimmed) as { title?: unknown; entries?: unknown; playlist_count?: unknown; n_entries?: unknown } | null
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.entries)) return null
  const tracks: PipelineTrackInput[] = []
  for (const raw of payload.entries as (PlaylistEntry | null)[]) {
    if (!raw) continue
    const track = entryToTrack(raw)
    if (track) tracks.push(track)
  }
  const declared = [payload.playlist_count, payload.n_entries, payload.entries.length]
    .find(value => typeof value === 'number' && value > 0) as number | undefined
  return {
    name: typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : null,
    tracks,
    expectedCount: declared ?? tracks.length,
  }
}

/** Reads the single-entry JSON yt-dlp prints for one resolved track page. */
export function parseTrackOutput(stdout: string): PipelineTrackInput | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  const line = trimmed.split(/\r?\n/).findLast(value => value.trim().startsWith('{'))?.trim()
  if (!line) return null
  let payload: PlaylistEntry | null
  try {
    payload = JSON.parse(line) as PlaylistEntry | null
  } catch {
    return null
  }
  if (!payload || typeof payload !== 'object') return null
  return entryToTrack(payload)
}

/**
 * `--ignore-errors` keeps the readable entries in stdout even when the process
 * exits non-zero because one record is DRM-protected. Losing the whole set over
 * a single bad entry would be worse than skipping it.
 */
export function playlistFromFailure(error: unknown): {
  name: string | null
  tracks: PipelineTrackInput[]
  expectedCount: number
  skippedDrm: boolean
} | null {
  if (!(error instanceof ProcessError)) return null
  const parsed = parsePlaylistOutput(error.stdout)
  return parsed?.tracks.length ? { ...parsed, skippedDrm: isDrmFailure(error) } : null
}

export class YtDlp {
  constructor(private readonly binary: string) {}

  /**
   * All calls go through the shared runner so a flapping tunnel gets the same
   * IPv4 retry as the web-source reader.
   */
  private async run(
    args: string[],
    options: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ProcessResult> {
    return await runYtDlp(this.binary, args, options)
  }

  async search(track: Pick<PipelineTrackInput, 'title' | 'artist'>, signal?: AbortSignal): Promise<AudioCandidate[]> {
    const query = buildSearchQuery(track)
    try {
      const { stdout } = await this.run(searchArguments(query), { timeoutMs: 60_000, signal })
      return parseSearchOutput(stdout)
    } catch (error) {
      if (signal?.aborted) throw error
      throw describeYtDlpFailure(error, 'https://www.youtube.com')
    }
  }

  /** Reads a public playlist page without a browser session. */
  async playlist(
    url: string,
    cookiesPath: string | null = null,
    signal?: AbortSignal,
    options: PlaylistOptions & { timeoutMs?: number } = {},
  ): Promise<{ name: string | null; tracks: PipelineTrackInput[]; expectedCount: number; skippedDrm?: boolean }> {
    let stdout: string
    try {
      ({ stdout } = await this.run(playlistArguments(url, cookiesPath, options), {
        timeoutMs: options.timeoutMs ?? 3 * 60_000, signal,
      }))
    } catch (error) {
      if (signal?.aborted) throw error
      const partial = playlistFromFailure(error)
      if (partial) return partial
      throw describeYtDlpFailure(error, url)
    }
    const parsed = parsePlaylistOutput(stdout)
    if (!parsed) throw new Error('Не удалось разобрать список треков из ответа yt-dlp')
    return parsed
  }

  /** Resolves one track page; used to enrich a flat set entry by entry. */
  async track(url: string, signal?: AbortSignal): Promise<PipelineTrackInput | null> {
    let stdout: string
    try {
      ({ stdout } = await this.run(trackArguments(url), {
        timeoutMs: 3 * 60_000, signal,
      }))
    } catch (error) {
      if (signal?.aborted) throw error
      throw describeYtDlpFailure(error, url)
    }
    return parseTrackOutput(stdout)
  }

  async download(candidate: AudioCandidate, directory: string, signal?: AbortSignal, format: DownloadFormat = 'original'): Promise<string> {
    await mkdir(directory, { recursive: true })
    let stdout: string
    try {
      ({ stdout } = await this.run(downloadArguments(candidate.url, directory, format), {
        timeoutMs: downloadTimeoutMs, signal,
      }))
    } catch (error) {
      if (signal?.aborted) throw error
      throw describeYtDlpFailure(error, candidate.url)
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
