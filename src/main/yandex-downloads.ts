import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { decryptEncraw, fullTitle, parseEncrawKey, YandexApi, YandexError } from './yandex-api'
import type { DownloadInfo, RawTrack } from './yandex-api'
import { containerForCodec, writeTags } from './yandex-tags'
import type { CoverImage, TrackTags } from './yandex-tags'
import { artworkMime } from './artwork'
import type { YandexDownload, YandexLyricsFormat, YandexQuality } from '../shared/contracts'

export interface DownloadConfig {
  token: string
  quality: YandexQuality
  lyrics: YandexLyricsFormat
  embedCover: boolean
  folder: string
}

export interface DownloadMeta {
  title: string
  artist: string | null
}

const maxTrackBytes = 512 * 1024 * 1024
const progressInterval = 250
const maxJobs = 200

function cleanComponent(name: string): string {
  const illegal = /[<>:"/\\|?*]/g
  let cleared = ''
  for (const char of name.replace(illegal, '_')) {
    cleared += char.codePointAt(0)! < 32 ? '_' : char
  }
  cleared = cleared.replace(/^[\s.]+|[\s.]+$/g, '').trim()
  return (cleared || 'track').slice(0, 180)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof YandexError) {
    if (error.kind === 'unauthorized') return 'Яндекс Музыка отклонила запрос: проверьте токен и активную подписку. ' + error.message
    if (error.kind === 'unavailable') {
      if (/subscription|plus|premium|подписк/i.test(error.message)) {
        return 'Загрузка требует активной подписки Яндекс Плюс. Оформите подписку и повторите. ' + error.message
      }
      return 'Яндекс Музыка не выдала ссылку на файл (трек или качество недоступны для загрузки). ' + error.message
    }
    if (error.kind === 'network') return 'Сетевая ошибка при загрузке: проверьте соединение и повторите. ' + error.message
  }
  return error instanceof Error && error.message ? error.message : 'Не удалось скачать трек'
}

function buildTags(track: RawTrack, lyrics: string | null, cover: CoverImage | null): TrackTags {
  const album = track.album
  const albumArtists = album && album.artists.length > 0 ? album.artists : track.artists
  return {
    title: fullTitle(track),
    album: album ? fullTitle(album) : 'Unknown Album',
    artists: track.artists.map(artist => artist.name),
    albumArtists: albumArtists.map(artist => artist.name),
    date: album?.releaseDate ?? (album?.year ? String(album.year) : null),
    trackNumber: album?.position?.index ?? null,
    discNumber: album?.position?.volume ?? null,
    genre: album?.genre ?? null,
    lyrics,
    comment: album ? `https://music.yandex.ru/album/${album.id}/track/${track.id}` : null,
    cover,
  }
}

export class YandexDownloads {
  private readonly jobs = new Map<string, YandexDownload>()
  private readonly configs = new Map<string, DownloadConfig>()
  private readonly controllers = new Map<string, AbortController>()
  private queue: string[] = []
  private running = false
  private disposed = false
  private lastEmit = 0

  constructor(private readonly onChange: (downloads: YandexDownload[]) => void,
    private readonly createApi: (token: string) => YandexApi = token => new YandexApi(token)) {}

  list(): YandexDownload[] {
    return [...this.jobs.values()].map(job => ({ ...job }))
  }

  enqueue(trackId: string, config: DownloadConfig, meta: DownloadMeta): YandexDownload {
    if (this.disposed) throw new Error('Загрузки остановлены')
    const id = randomUUID()
    const job: YandexDownload = {
      id, trackId, title: meta.title, artist: meta.artist, status: 'queued',
      progress: 0, receivedBytes: 0, totalBytes: 0, error: null,
    }
    this.jobs.set(id, job)
    this.configs.set(id, config)
    this.queue.push(id)
    this.prune()
    this.emit(true)
    void this.run()
    return { ...job }
  }

  cancel(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (job.status === 'queued') {
      this.queue = this.queue.filter(entry => entry !== id)
      this.configs.delete(id)
      this.update(id, { status: 'cancelled' })
    } else if (job.status === 'downloading' || job.status === 'tagging') {
      this.controllers.get(id)?.abort()
    }
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
    for (const controller of this.controllers.values()) controller.abort()
  }

  private prune(): void {
    if (this.jobs.size <= maxJobs) return
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= maxJobs) break
      if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
        this.jobs.delete(id)
        this.configs.delete(id)
      }
    }
  }

  private emit(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < progressInterval) return
    this.lastEmit = now
    this.onChange(this.list())
  }

  private update(id: string, patch: Partial<YandexDownload>, force = true): void {
    const job = this.jobs.get(id)
    if (!job) return
    Object.assign(job, patch)
    this.emit(force)
  }

  private async run(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.disposed) {
        const id = this.queue.shift()
        if (!id) break
        const job = this.jobs.get(id)
        if (!job || job.status !== 'queued') continue
        await this.process(id)
      }
    } finally {
      this.running = false
    }
  }

  private async process(id: string): Promise<void> {
    const job = this.jobs.get(id)!
    const config = this.configs.get(id)!
    const controller = new AbortController()
    this.controllers.set(id, controller)
    const { signal } = controller
    const api = this.createApi(config.token)
    let tempRaw: string | null = null
    let tempFinal: string | null = null
    let outcome: Partial<YandexDownload>
    try {
      this.update(id, { status: 'downloading' })
      const track = await api.track(job.trackId, signal)
      this.update(id, { title: fullTitle(track), artist: track.artists.map(artist => artist.name).join(', ') || null })
      const info = await api.fileInfo(job.trackId, config.quality, signal)
      // An unusable encraw key means the stream cannot be decrypted; the raw transport
      // serves the same track as a plain stream without a key.
      const usable = info.key ? parseEncrawKey(info.key) !== null : true
      const stream = usable ? info : await api.fileInfo(job.trackId, config.quality, signal, 'raw')
      const container = containerForCodec(stream.codec)
      if (!container) throw new YandexError('unavailable', 'Неподдерживаемый кодек: ' + stream.codec)
      const target = await this.targetPath(config.folder, track, container.extension)
      await mkdir(dirname(target), { recursive: true })
      tempRaw = join(config.folder, `.mustplay-${id}.raw.tmp`)
      tempFinal = join(config.folder, `.mustplay-${id}.tmp`)
      const received = await this.download(api, stream, tempRaw, signal, (bytes, total) => {
        this.update(id, {
          receivedBytes: bytes, totalBytes: total,
          progress: total > 0 ? Math.min(0.9, (bytes / total) * 0.9) : 0,
        }, false)
      })
      let audio: Buffer = await readFile(tempRaw)
      await rm(tempRaw, { force: true })
      tempRaw = null
      if (stream.key) audio = decryptEncraw(audio, stream.key)
      this.update(id, { status: 'tagging', progress: 0.92 })
      const lyrics = await this.fetchLyrics(api, track, config.lyrics, signal)
      const cover = config.embedCover ? await this.fetchCover(api, track, signal) : null
      const tagged = writeTags(container.container, audio, buildTags(track, lyrics.text, cover))
      await writeFile(tempFinal, tagged)
      await rename(tempFinal, target)
      tempFinal = null
      if (lyrics.lrc) {
        await writeFile(target.slice(0, target.length - container.extension.length) + '.lrc', lyrics.lrc, 'utf8')
      }
      outcome = { status: 'complete', progress: 1, receivedBytes: received, totalBytes: received }
    } catch (error) {
      outcome = signal.aborted || this.disposed
        ? { status: 'cancelled', error: null }
        : { status: 'error', error: errorMessage(error) }
    } finally {
      this.controllers.delete(id)
      this.configs.delete(id)
      if (tempRaw) await rm(tempRaw, { force: true }).catch(() => undefined)
      if (tempFinal) await rm(tempFinal, { force: true }).catch(() => undefined)
    }
    this.update(id, outcome)
  }

  private async targetPath(folder: string, track: RawTrack, extension: string): Promise<string> {
    const album = track.album
    const albumArtist = album?.artists[0]?.name ?? track.artists[0]?.name ?? 'Unknown Artist'
    const albumTitle = album ? fullTitle(album) : 'Unknown Album'
    const number = album?.position?.index
    const base = number != null ? `${String(number).padStart(2, '0')} - ${fullTitle(track)}` : fullTitle(track)
    const directory = join(folder, cleanComponent(albumArtist), cleanComponent(albumTitle))
    const target = join(directory, cleanComponent(base) + extension)
    if (await exists(target)) return join(directory, cleanComponent(`${base} (${track.id})`) + extension)
    return target
  }

  private async download(api: YandexApi, info: DownloadInfo, tempRaw: string, signal: AbortSignal,
    onProgress: (received: number, total: number) => void): Promise<number> {
    let lastError: unknown = null
    for (const url of info.urls) {
      let file: Awaited<ReturnType<typeof open>> | null = null
      try {
        const response = await api.openDownload(url, signal)
        const total = Number(response.headers['content-length'] ?? 0) || 0
        file = await open(tempRaw, 'w')
        let received = 0
        try {
          for await (const chunk of response) {
            if (signal.aborted) throw new YandexError('network', 'Запрос отменён')
            const data = chunk as Buffer<ArrayBuffer>
            received += data.length
            if (received > maxTrackBytes) throw new YandexError('invalid', 'Файл слишком большой')
            await file.write(data)
            onProgress(received, total)
          }
        } finally {
          response.destroy()
        }
        await file.close()
        file = null
        if (received === 0) throw new YandexError('network', 'Пустой ответ сервера')
        return received
      } catch (error) {
        if (file) await file.close().catch(() => undefined)
        if (signal.aborted) throw error
        lastError = error
        await rm(tempRaw, { force: true }).catch(() => undefined)
      }
    }
    throw lastError instanceof Error ? lastError : new YandexError('network', 'Не удалось скачать файл')
  }

  private async fetchLyrics(api: YandexApi, track: RawTrack, format: YandexLyricsFormat,
    signal: AbortSignal): Promise<{ lrc: string | null; text: string | null }> {
    if (format === 'none') return { lrc: null, text: null }
    const optional = async (request: Promise<string | null>): Promise<string | null> => {
      try {
        return await request
      } catch (error) {
        if (signal.aborted) throw error
        return null
      }
    }
    if (format === 'lrc') {
      const lrc = await optional(api.lyrics(track.id, 'LRC', signal))
      return { lrc, text: lrc ? null : await optional(api.lyrics(track.id, 'TEXT', signal)) }
    }
    const text = await optional(api.lyrics(track.id, 'TEXT', signal))
    return { text, lrc: text ? null : await optional(api.lyrics(track.id, 'LRC', signal)) }
  }

  private async fetchCover(api: YandexApi, track: RawTrack, signal: AbortSignal): Promise<CoverImage | null> {
    const uri = track.coverUri ?? track.album?.coverUri
    if (!uri) return null
    try {
      const data = await api.cover(uri, '400x400', signal)
      const mime = artworkMime(data)
      return mime ? { data, mime } : null
    } catch (error) {
      if (signal.aborted) throw error
      return null
    }
  }
}