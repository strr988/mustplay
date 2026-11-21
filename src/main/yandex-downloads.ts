import { createDecipheriv, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import { copyFile, link, mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fullTitle, parseEncrawKey, YandexApi, YandexError } from './yandex-api'
import type { DownloadInfo, RawTrack } from './yandex-api'
import { containerForCodec, writeM4aMovie, writeTags } from './yandex-tags'
import type { CoverImage, TagContainer, TrackTags } from './yandex-tags'
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

const maxBufferedTagBytes = 64 * 1024 * 1024

function fileError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}

async function copyAudioRange(source: string, target: string, start: number, end: number, signal: AbortSignal) {
  if (start >= end) return
  await pipeline(createReadStream(source, { start, end: end - 1 }),
    createWriteStream(target, { flags: 'a' }), { signal })
}

async function tagM4a(source: string, target: string, tags: TrackTags, size: number, signal: AbortSignal) {
  const file = await open(source, 'r')
  let offset = 0
  let movie: Buffer | undefined
  let movieLength = 0
  try {
    const header = Buffer.alloc(16)
    while (offset < size) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(header, 0, header.length, offset)
      if (bytesRead < 8) throw new Error('Повреждённый контейнер MP4')
      const length = header.readUInt32BE(0)
      const atomLength = length === 1 && bytesRead === 16 ? Number(header.readBigUInt64BE(8))
        : length === 0 ? size - offset : length
      if (atomLength < (length === 1 ? 16 : 8) || atomLength > size - offset) {
        throw new Error('Некорректный размер атома MP4')
      }
      if (header.toString('latin1', 4, 8) === 'moov') {
        if (atomLength > maxBufferedTagBytes) throw new Error('Метаданные MP4 слишком велики')
        const bytes = Buffer.alloc(atomLength)
        if ((await file.read(bytes, 0, atomLength, offset)).bytesRead !== atomLength) {
          throw new Error('Повреждённые метаданные MP4')
        }
        movie = writeM4aMovie(bytes, offset, tags)
        movieLength = atomLength
        break
      }
      offset += atomLength
    }
  } finally {
    await file.close()
  }
  if (!movie) throw new Error('В контейнере MP4 нет атома moov')
  await writeFile(target, '', { signal, flag: 'wx' })
  await copyAudioRange(source, target, 0, offset, signal)
  await writeFile(target, movie, { signal, flag: 'a' })
  await copyAudioRange(source, target, offset + movieLength, size, signal)
}

async function tagFile(source: string, target: string, container: TagContainer, tags: TrackTags,
  size: number, signal: AbortSignal): Promise<void> {
  if (container === 'm4a') {
    await tagM4a(source, target, tags, size, signal)
    return
  }

  let offset = 0
  let prefix: Buffer = Buffer.alloc(0)
  const file = await open(source, 'r')
  try {
    if (container === 'mp3') {
      const header = Buffer.alloc(10)
      const { bytesRead } = await file.read(header, 0, 10, 0)
      if (bytesRead === 10 && header.toString('ascii', 0, 3) === 'ID3') {
        const bodySize = header.subarray(6, 10).reduce((total, byte) => total * 128 + byte, 0)
        const end = 10 + bodySize + (header[3] === 4 && (header[5] & 0x10) ? 10 : 0)
        if (end <= size) offset = end
      }
    } else {
      offset = 4
      const header = Buffer.alloc(4)
      for (;;) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(header, 0, 4, offset)
        if (bytesRead !== 4) throw new Error('Повреждённые метаданные FLAC')
        offset += 4 + header.readUIntBE(1, 3)
        if (offset > size || offset > maxBufferedTagBytes) throw new Error('Некорректный размер метаданных FLAC')
        if ((header[0] & 0x80) !== 0) break
      }
      prefix = Buffer.alloc(offset)
      if ((await file.read(prefix, 0, offset, 0)).bytesRead !== offset) throw new Error('Повреждённые метаданные FLAC')
    }
  } finally {
    await file.close()
  }

  await writeFile(target, writeTags(container, prefix, tags), { signal, flag: 'wx' })
  await copyAudioRange(source, target, offset, size, signal)
}

async function publishExclusive(source: string, target: string): Promise<void> {
  try {
    await link(source, target)
  } catch (error) {
    if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].some(code => fileError(error, code))) throw error
    // FAT/exFAT and some mounted folders do not support hard links.
    await copyFile(source, target, constants.COPYFILE_EXCL)
  }
}

async function publishAudio(source: string, stem: string, extension: string, trackId: string, lyrics: string | null,
  signal: AbortSignal): Promise<void> {
  const lyricsSource = source + '.lrc'
  if (lyrics) await writeFile(lyricsSource, lyrics, { encoding: 'utf8', signal, flag: 'wx' })
  try {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      signal.throwIfAborted()
      const suffix = attempt === 0 ? '' : attempt === 1 ? ' (' + trackId + ')' : ' (' + trackId + '-' + attempt + ')'
      const candidate = stem + suffix
      const audio = candidate + extension
      try {
        await publishExclusive(source, audio)
      } catch (error) {
        if (fileError(error, 'EEXIST')) continue
        throw error
      }
      if (!lyrics) return
      try {
        await publishExclusive(lyricsSource, candidate + '.lrc')
        return
      } catch (error) {
        await rm(audio)
        if (!fileError(error, 'EEXIST')) throw error
      }
    }
    throw new Error('Не удалось выбрать свободное имя файла')
  } finally {
    if (lyrics) await rm(lyricsSource, { force: true }).catch(() => undefined)
  }
}

function errorMessage(error: unknown): string {
  if (fileError(error, 'ENOSPC')) return 'На диске недостаточно свободного места.'
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

  clearHistory(): void {
    for (const [id, job] of this.jobs) {
      if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') this.jobs.delete(id)
    }
    this.emit(true)
  }

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
      const stem = this.targetStem(config.folder, track)
      await mkdir(dirname(stem), { recursive: true })
      tempRaw = join(dirname(stem), '.mustplay-' + id + '.raw.tmp')
      tempFinal = join(dirname(stem), '.mustplay-' + id + '.tmp')
      const received = await this.download(api, stream, tempRaw, signal, (bytes, total) => {
        this.update(id, {
          receivedBytes: bytes, totalBytes: total,
          progress: total > 0 ? Math.min(0.9, (bytes / total) * 0.9) : 0,
        }, false)
      })
      this.update(id, { status: 'tagging', progress: 0.92 })
      const lyrics = await this.fetchLyrics(api, track, config.lyrics, signal)
      const cover = config.embedCover ? await this.fetchCover(api, track, signal) : null
      await tagFile(tempRaw, tempFinal, container.container, buildTags(track, lyrics.text, cover), received, signal)
      await publishAudio(tempFinal, stem, container.extension, cleanComponent(track.id), lyrics.lrc, signal)
      outcome = { status: 'complete', progress: 1, receivedBytes: received, totalBytes: received }
    } catch (error) {
      outcome = signal.aborted || this.disposed
        ? { status: 'cancelled', error: null }
        : { status: 'error', error: errorMessage(error) }
    } finally {
      this.controllers.delete(id)
      this.configs.delete(id)
      if (tempRaw) await rm(tempRaw, { force: true }).catch(() => undefined)
      if (tempFinal) {
        await rm(tempFinal, { force: true }).catch(() => undefined)
        await rm(tempFinal + '.lrc', { force: true }).catch(() => undefined)
      }
    }
    this.update(id, outcome)
  }

  private targetStem(folder: string, track: RawTrack): string {
    const album = track.album
    const albumArtist = album?.artists[0]?.name ?? track.artists[0]?.name ?? 'Unknown Artist'
    const albumTitle = album ? fullTitle(album) : 'Unknown Album'
    const number = album?.position?.index
    const base = number != null ? `${String(number).padStart(2, '0')} - ${fullTitle(track)}` : fullTitle(track)
    const directory = join(folder, cleanComponent(albumArtist), cleanComponent(albumTitle))
    return join(directory, cleanComponent(base))
  }

  private async download(api: YandexApi, info: DownloadInfo, tempRaw: string, signal: AbortSignal,
    onProgress: (received: number, total: number) => void): Promise<number> {
    let lastError: unknown = null
    const key = info.key ? parseEncrawKey(info.key) : null
    for (const url of info.urls) {
      const decipher = key ? createDecipheriv('aes-256-ctr', key, Buffer.alloc(16)) : null
      let file: Awaited<ReturnType<typeof open>> | null = null
      try {
        const response = await api.openDownload(url, signal)
        const total = Number(response.headers['content-length'] ?? 0) || 0
        let received = 0
        try {
          if (total > maxTrackBytes) throw new YandexError('invalid', 'Файл слишком большой')
          file = await open(tempRaw, 'wx')
          for await (const chunk of response) {
            if (signal.aborted) throw new YandexError('network', 'Запрос отменён')
            const data = chunk as Buffer<ArrayBuffer>
            received += data.length
            if (received > maxTrackBytes) throw new YandexError('invalid', 'Файл слишком большой')
            await file.writeFile(decipher ? decipher.update(data) : data)
            onProgress(received, total)
          }
        } finally {
          response.destroy()
        }
        await file.close()
        file = null
        if (received === 0) throw new YandexError('network', 'Пустой ответ сервера')
        if (total > 0 && received !== total) throw new YandexError('network', 'Поток аудио оборвался')
        return received
      } catch (error) {
        if (file) await file.close().catch(() => undefined)
        if (signal.aborted || fileError(error, 'ENOSPC')) throw error
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