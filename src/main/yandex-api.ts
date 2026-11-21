import { createDecipheriv, createHmac } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { YandexQuality } from '../shared/contracts'

const API_ORIGIN = 'https://api.music.yandex.net'
const SIGN_KEY = 'p93jhgh689SBReK6ghtw62'
const CODECS = ['flac', 'flac-mp4', 'mp3', 'aac', 'he-aac', 'aac-mp4', 'he-aac-mp4']
const CLIENT = 'YandexMusicAndroid/24023621'
const USER_AGENT = 'Yandex-Music-API'
const requestTimeout = 20_000
const maxJsonBytes = 8 * 1024 * 1024
const maxCoverBytes = 4 * 1024 * 1024
const maxLyricsBytes = 1024 * 1024

export type YandexErrorKind = 'unauthorized' | 'unavailable' | 'network' | 'invalid'
export class YandexError extends Error {
  constructor(public readonly kind: YandexErrorKind, message: string) {
    super(message)
    this.name = 'YandexError'
  }
}

export interface DownloadInfo {
  quality: string
  codec: string
  urls: string[]
  bitrate: number
  key: string | null
}

export interface RawTrack {
  id: string
  title: string
  version: string | null
  available: boolean
  durationMs: number | null
  coverUri: string | null
  artists: { id: string; name: string }[]
  album: RawAlbum | null
  hasSyncLyrics: boolean
  hasTextLyrics: boolean
}

export interface RawAlbum {
  id: string
  title: string
  version: string | null
  year: number | null
  genre: string | null
  releaseDate: string | null
  coverUri: string | null
  trackCount: number | null
  artists: { id: string; name: string }[]
  position: { index: number | null; volume: number | null } | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key]
  return undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function fileInfoSign(trackId: string, quality: string, ts: number, transport = 'encraw'): string {
  const message = `${ts}${trackId}${quality}${CODECS.join('')}${transport}`
  return createHmac('sha256', SIGN_KEY).update(message).digest('base64').slice(0, -1)
}

export function lyricsSign(trackId: string, ts: number): string {
  return createHmac('sha256', SIGN_KEY).update(`${trackId}${ts}`).digest('base64')
}

// The server has been observed to hand the encraw key as hex or base64; Buffer.from
// silently truncates malformed input, so accept only exact round-trips of 32 bytes.
export function parseEncrawKey(value: string): Buffer | null {
  const hex = Buffer.from(value, 'hex')
  if (hex.length === 32 && hex.toString('hex') === value.toLowerCase()) return hex
  const base64 = Buffer.from(value, 'base64')
  if (base64.length === 32 && base64.toString('base64') === value) return base64
  return null
}

export function decryptEncraw(data: Buffer, keyHex: string): Buffer {
  const key = parseEncrawKey(keyHex)
  if (!key) throw new YandexError('invalid', `Некорректный ключ расшифровки (длина ${keyHex.length})`)
  // encraw uses AES-256-CTR with a zero nonce and a zero initial counter block.
  const decipher = createDecipheriv('aes-256-ctr', key, Buffer.alloc(16, 0))
  return Buffer.concat([decipher.update(data), decipher.final()])
}

function baseHeaders(token: string | null, url: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'X-Yandex-Music-Client': CLIENT,
    Accept: 'application/json',
  }
  if (token && URL.parse(url)?.origin === API_ORIGIN) headers.Authorization = `OAuth ${token}`
  return headers
}

function classify(status: number, body: Buffer): YandexError {
  let message = `HTTP ${status}`
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown
    if (isObject(parsed)) {
      const description = text(pick(parsed, 'errorDescription', 'error_description', 'message'))
      const error = text(parsed.error)
      message = description ?? error ?? message
    }
  } catch {
    // Keep the status-based message.
  }
  if (status === 401 || status === 403) return new YandexError('unauthorized', message)
  if (status === 404) return new YandexError('unavailable', message)
  if (status === 400) return new YandexError('invalid', message)
  return new YandexError('network', message)
}

export function httpsGet(url: string, options: {
  headers?: Record<string, string>
  signal?: AbortSignal
  timeout?: number
} = {}): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      fail(new YandexError('invalid', 'Некорректный адрес запроса'))
      return
    }
    if (parsed.protocol !== 'https:') {
      fail(new YandexError('invalid', 'Разрешены только HTTPS-запросы'))
      return
    }
    const request = httpsRequest(parsed, { method: 'GET', headers: options.headers, signal: options.signal }, response => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= 64 * 1024) chunks.push(chunk)
        })
        response.on('end', () => fail(classify(status, Buffer.concat(chunks))))
        response.on('error', () => fail(classify(status, Buffer.concat(chunks))))
        return
      }
      if (settled) {
        response.destroy()
        return
      }
      settled = true
      resolve(response)
    })
    request.setTimeout(options.timeout ?? requestTimeout, () => {
      request.destroy(new YandexError('network', 'Превышено время ожидания ответа'))
    })
    request.on('error', error => {
      const detail = options.signal?.aborted ? 'Запрос отменён' : 'Сетевая ошибка'
      fail(error instanceof YandexError ? error : new YandexError('network', detail))
    })
    request.end()
  })
}

async function collect(response: IncomingMessage, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw new YandexError('network', 'Запрос отменён')
      size += (chunk as Buffer).length
      if (size > maxBytes) throw new YandexError('invalid', 'Ответ сервера слишком большой')
      chunks.push(chunk as Buffer)
    }
  } finally {
    response.destroy()
  }
  return Buffer.concat(chunks)
}

async function getBuffer(url: string, maxBytes: number, token: string | null, signal?: AbortSignal): Promise<Buffer> {
  const response = await httpsGet(url, { headers: baseHeaders(token, url), signal })
  return collect(response, maxBytes, signal)
}

async function getJson(url: string, token: string | null, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const body = await getBuffer(url, maxJsonBytes, token, signal)
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new YandexError('invalid', 'Сервер вернул некорректный ответ')
  }
  if (!isObject(parsed)) throw new YandexError('invalid', 'Сервер вернул некорректный ответ')
  const result = parsed.result
  return isObject(result) ? result : parsed
}

function normalizeArtists(value: unknown): { id: string; name: string }[] {
  if (!Array.isArray(value)) return []
  const artists: { id: string; name: string }[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const name = text(entry.name)
    if (!name) continue
    artists.push({ id: String(pick(entry, 'id') ?? ''), name })
  }
  return artists
}

function normalizeAlbum(value: unknown): RawAlbum | null {
  if (!isObject(value)) return null
  const position = pick(value, 'trackPosition', 'track_position')
  return {
    id: String(pick(value, 'id') ?? ''),
    title: text(pick(value, 'title')) ?? '',
    version: text(pick(value, 'version')),
    year: num(pick(value, 'year')),
    genre: text(pick(value, 'genre')),
    releaseDate: text(pick(value, 'releaseDate', 'release_date')),
    coverUri: text(pick(value, 'coverUri', 'cover_uri')),
    trackCount: num(pick(value, 'trackCount', 'track_count')),
    artists: normalizeArtists(pick(value, 'artists')),
    position: isObject(position)
      ? { index: num(pick(position, 'index')), volume: num(pick(position, 'volume')) }
      : null,
  }
}

// getJson unwraps only object results, so the /tracks array stays inside the envelope.
export function trackEntry(value: unknown): unknown {
  const payload = isObject(value) && Array.isArray(value.result) ? value.result : value
  if (Array.isArray(payload)) return payload[0]
  if (isObject(payload) && Array.isArray(payload.tracks)) return payload.tracks[0]
  return payload
}

export function normalizeTrack(value: unknown): RawTrack | null {
  if (!isObject(value)) return null
  const id = pick(value, 'id')
  if (id === undefined) return null
  const albums = pick(value, 'albums')
  const album = Array.isArray(albums) && albums.length > 0 ? normalizeAlbum(albums[0]) : null
  const lyricsInfo = pick(value, 'lyricsInfo', 'lyrics_info')
  const durationMs = num(pick(value, 'durationMs', 'duration_ms'))
  return {
    id: String(id),
    title: text(pick(value, 'title')) ?? '',
    version: text(pick(value, 'version')),
    available: pick(value, 'available') !== false,
    durationMs,
    coverUri: text(pick(value, 'coverUri', 'cover_uri')) ?? album?.coverUri ?? text(pick(value, 'ogImage', 'og_image')),
    artists: normalizeArtists(pick(value, 'artists')),
    album,
    hasSyncLyrics: isObject(lyricsInfo) ? pick(lyricsInfo, 'hasAvailableSyncLyrics', 'has_available_sync_lyrics') === true : false,
    hasTextLyrics: isObject(lyricsInfo) ? pick(lyricsInfo, 'hasAvailableTextLyrics', 'has_available_text_lyrics') === true : false,
  }
}

export function fullTitle(item: { title: string; version: string | null }): string {
  return item.version ? `${item.title} (${item.version})` : item.title
}

export function coverUrl(coverUri: string, size: '400x400' | 'orig'): string {
  return `https://${coverUri.replace('%%', size)}`
}

export class YandexApi {
  constructor(private readonly token: string) {}

  async verify(signal?: AbortSignal): Promise<void> {
    await getJson(`${API_ORIGIN}/account/status`, this.token, signal)
  }

  async search(query: string, page: number, signal?: AbortSignal): Promise<{ tracks: RawTrack[]; total: number; perPage: number }> {
    const params = new URLSearchParams({
      text: query, nocorrect: 'false', type: 'track', page: String(page), 'playlist-in-best': 'true',
    })
    const result = await getJson(`${API_ORIGIN}/search?${params}`, this.token, signal)
    const list = pick(result, 'tracks')
    const tracks: RawTrack[] = []
    if (isObject(list)) {
      const results = pick(list, 'results')
      if (Array.isArray(results)) {
        for (const entry of results) {
          const track = normalizeTrack(entry)
          if (track) tracks.push(track)
        }
      }
      const total = num(pick(list, 'total')) ?? tracks.length
      const perPage = num(pick(list, 'perPage', 'per_page')) ?? (tracks.length || 20)
      return { tracks, total, perPage }
    }
    return { tracks, total: 0, perPage: 20 }
  }

  async track(trackId: string, signal?: AbortSignal): Promise<RawTrack> {
    const result = await getJson(`${API_ORIGIN}/tracks/${trackId}?with-positions=true`, this.token, signal)
    const track = normalizeTrack(trackEntry(result))
    if (!track) throw new YandexError('unavailable', 'Трек не найден')
    return track
  }

  async fileInfo(trackId: string, quality: YandexQuality, signal?: AbortSignal, transport: 'encraw' | 'raw' = 'encraw'): Promise<DownloadInfo> {
    const ts = Math.floor(Date.now() / 1000)
    const params = new URLSearchParams({
      ts: String(ts), trackId, quality, codecs: CODECS.join(','), transports: transport,
      sign: fileInfoSign(trackId, quality, ts, transport),
    })
    const result = await getJson(`${API_ORIGIN}/get-file-info?${params}`, this.token, signal)
    const serverError = text(pick(result, 'errorDescription', 'error_description', 'message')) ?? text(result.error)
    const info = pick(result, 'downloadInfo', 'download_info')
    if (!isObject(info)) throw new YandexError('unavailable', serverError ?? 'Сервер не вернул ссылку на файл')
    const list = pick(info, 'urls')
    const single = text(pick(info, 'url'))
    const codec = text(pick(info, 'codec'))
    const urls = (Array.isArray(list) ? list : single ? [single] : [])
      .filter((url): url is string => typeof url === 'string' && url.startsWith('https://'))
    if (!codec || urls.length === 0) {
      throw new YandexError('unavailable', serverError ?? 'Трек недоступен для загрузки в этом качестве')
    }
    return {
      quality: text(pick(info, 'quality')) ?? quality,
      codec,
      urls,
      bitrate: num(pick(info, 'bitrate')) ?? 0,
      key: text(pick(info, 'key')),
    }
  }

  async lyrics(trackId: string, format: 'LRC' | 'TEXT', signal?: AbortSignal): Promise<string | null> {
    const ts = Math.floor(Date.now() / 1000)
    const params = new URLSearchParams({ format, timeStamp: String(ts), sign: lyricsSign(trackId, ts) })
    let result: Record<string, unknown>
    try {
      result = await getJson(`${API_ORIGIN}/tracks/${trackId}/lyrics?${params}`, this.token, signal)
    } catch (error) {
      if (error instanceof YandexError && error.kind === 'unavailable') return null
      throw error
    }
    const url = text(pick(result, 'downloadUrl', 'download_url'))
    if (!url) return null
    const body = await getBuffer(url, maxLyricsBytes, this.token, signal)
    return body.toString('utf8')
  }

  async cover(coverUri: string, size: '400x400' | 'orig', signal?: AbortSignal): Promise<Buffer> {
    return getBuffer(coverUrl(coverUri, size), maxCoverBytes, null, signal)
  }

  openDownload(url: string, signal?: AbortSignal): Promise<IncomingMessage> {
    return httpsGet(url, { headers: baseHeaders(this.token, url), signal, timeout: 60_000 })
  }
}