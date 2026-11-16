import { createCipheriv } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseFile } from 'music-metadata'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { YandexDownloads } from '../src/main/yandex-downloads'
import type { DownloadConfig } from '../src/main/yandex-downloads'
import type { DownloadInfo, RawTrack, YandexApi } from '../src/main/yandex-api'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url))
let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'mustplay-downloads-'))
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

const track: RawTrack = {
  id: '123', title: 'Тест/B:C', version: null, available: true, durationMs: 4000,
  coverUri: 'avatars.yandex.net/get-music/%%/cover', artists: [{ id: '1', name: 'Исполнитель' }],
  album: {
    id: '9', title: 'Альбом', version: null, year: 2024, genre: 'Electronic', releaseDate: '2024-01-01',
    coverUri: null, trackCount: 10, artists: [{ id: '2', name: 'Альбомный' }], position: { index: 3, volume: 1 },
  },
  hasSyncLyrics: true, hasTextLyrics: true,
}

function streamOf(bytes: Buffer, signal?: AbortSignal): Readable {
  const stream = Readable.from([bytes]) as Readable & { headers: Record<string, string> }
  stream.headers = { 'content-length': String(bytes.length) }
  signal?.addEventListener('abort', () => stream.destroy(new Error('aborted')))
  return stream
}

interface FakeOptions {
  audio: Buffer
  info?: Partial<DownloadInfo>
  rawInfo?: Partial<DownloadInfo>
  lyrics?: string | null
  cover?: Buffer
  gate?: Promise<void>
  hang?: boolean
}

function fakeApi(options: FakeOptions): YandexApi {
  const info: DownloadInfo = { quality: 'nq', codec: 'mp3', urls: ['https://cdn.example/file'], bitrate: 320, key: null, ...options.info }
  const raw: DownloadInfo = { ...info, key: null, ...options.rawInfo }
  return {
    track: async () => { if (options.gate) await options.gate; return track },
    fileInfo: async (_id: string, _quality: string, _signal?: AbortSignal, transport?: string) => transport === 'raw' ? raw : info,
    lyrics: async () => options.lyrics ?? null,
    cover: async () => options.cover ?? Buffer.alloc(0),
    openDownload: async (_url: string, signal?: AbortSignal) => {
      if (options.hang) {
        const stream = new Readable({ read() {} }) as Readable & { headers: Record<string, string> }
        stream.headers = { 'content-length': '4096' }
        const timer = setInterval(() => stream.push(Buffer.alloc(16)), 10)
        stream.on('close', () => clearInterval(timer))
        signal?.addEventListener('abort', () => { clearInterval(timer); stream.destroy(new Error('aborted')) })
        return stream
      }
      return streamOf(options.audio, signal)
    },
  } as unknown as YandexApi
}

function config(overrides: Partial<DownloadConfig> = {}): DownloadConfig {
  return { token: 'token', quality: 'nq', lyrics: 'text', embedCover: true, folder, ...overrides }
}

async function settle(manager: YandexDownloads, id: string) {
  for (let attempt = 0; attempt < 400; attempt++) {
    const job = manager.list().find(entry => entry.id === id)
    if (job && (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled')) return job
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Download did not settle in time')
}

it('downloads, decrypts nothing, tags and renames an MP3 into a sanitized path', async () => {
  const [mp3, cover] = await Promise.all([fixture('01-tone.mp3'), fixture('cover.jpg')])
  const manager = new YandexDownloads(() => undefined, () => fakeApi({ audio: mp3, cover, lyrics: 'Строка текста' }))
  const job = manager.enqueue('123', config(), { title: 'Тест/B:C', artist: 'Исполнитель' })
  const settled = await settle(manager, job.id)
  expect(settled.status).toBe('complete')
  expect(settled.progress).toBe(1)
  expect(settled.title).toBe('Тест/B:C')
  const target = join(folder, 'Альбомный', 'Альбом', '03 - Тест_B_C.mp3')
  const metadata = await parseFile(target)
  expect(metadata.common.title).toBe('Тест/B:C')
  expect(metadata.common.album).toBe('Альбом')
  expect(metadata.common.artist).toContain('Исполнитель')
  expect(metadata.common.albumartist).toContain('Альбомный')
  expect(metadata.common.track.no).toBe(3)
  expect(metadata.common.year).toBe(2024)
  expect(metadata.common.picture?.length).toBe(1)
  expect(metadata.format.duration).toBeGreaterThan(0)
  expect((await readdir(folder)).filter(name => name.startsWith('.mustplay-'))).toEqual([])
  manager.dispose()
})

it('decrypts an encraw FLAC stream before tagging', async () => {
  const flac = await fixture('02-tone.flac')
  const key = Buffer.alloc(32, 7)
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16, 0))
  const encrypted = Buffer.concat([cipher.update(flac), cipher.final()])
  const manager = new YandexDownloads(() => undefined,
    () => fakeApi({ audio: encrypted, info: { codec: 'flac', quality: 'lossless', key: key.toString('hex') }, lyrics: null }))
  const job = manager.enqueue('123', config({ quality: 'lossless', embedCover: false }), { title: '', artist: null })
  const settled = await settle(manager, job.id)
  expect(settled.status).toBe('complete')
  const target = join(folder, 'Альбомный', 'Альбом', '03 - Тест_B_C.flac')
  const metadata = await parseFile(target)
  expect(metadata.common.title).toBe('Тест/B:C')
  expect(metadata.format.duration).toBeGreaterThan(0)
  expect(metadata.format.container?.toLowerCase()).toBe('flac')
  manager.dispose()
})

it('falls back to the raw transport when the encraw key is unusable', async () => {
  const mp3 = await fixture('01-tone.mp3')
  const api = fakeApi({ audio: mp3, info: { key: 'not-a-key' }, lyrics: null })
  const transports: string[] = []
  const request = api.fileInfo.bind(api)
  api.fileInfo = (id, quality, signal, transport) => {
    transports.push(transport ?? 'encraw')
    return request(id, quality, signal, transport)
  }
  const manager = new YandexDownloads(() => undefined, () => api)
  const job = manager.enqueue('123', config({ embedCover: false }), { title: '', artist: null })
  const settled = await settle(manager, job.id)
  expect(settled.status).toBe('complete')
  expect(transports).toEqual(['encraw', 'raw'])
  const target = join(folder, 'Альбомный', 'Альбом', '03 - Тест_B_C.mp3')
  const metadata = await parseFile(target)
  expect(metadata.format.duration).toBeGreaterThan(0)
  manager.dispose()
})

it('writes a synchronized .lrc sidecar next to the audio file', async () => {
  const mp3 = await fixture('01-tone.mp3')
  const lrc = '[00:01.00]Первая строка\n[00:03.00]Вторая строка'
  const manager = new YandexDownloads(() => undefined, () => fakeApi({ audio: mp3, lyrics: lrc }))
  const job = manager.enqueue('123', config({ lyrics: 'lrc', embedCover: false }), { title: '', artist: null })
  expect((await settle(manager, job.id)).status).toBe('complete')
  const sidecar = join(folder, 'Альбомный', 'Альбом', '03 - Тест_B_C.lrc')
  expect(await readFile(sidecar, 'utf8')).toBe(lrc)
  manager.dispose()
})

it('cancels a queued download without touching the active one', async () => {
  const mp3 = await fixture('01-tone.mp3')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const manager = new YandexDownloads(() => undefined, () => fakeApi({ audio: mp3, gate }))
  const first = manager.enqueue('123', config({ embedCover: false }), { title: 'Первый', artist: null })
  const second = manager.enqueue('456', config({ embedCover: false }), { title: 'Второй', artist: null })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(manager.list().find(entry => entry.id === first.id)?.status).toBe('downloading')
  manager.cancel(second.id)
  expect(manager.list().find(entry => entry.id === second.id)?.status).toBe('cancelled')
  release()
  expect((await settle(manager, first.id)).status).toBe('complete')
  manager.dispose()
})

it('aborts an in-flight download and removes its temporary file', async () => {
  const manager = new YandexDownloads(() => undefined, () => fakeApi({ audio: Buffer.alloc(0), hang: true }))
  const job = manager.enqueue('123', config(), { title: '', artist: null })
  for (let attempt = 0; attempt < 200 && manager.list().find(e => e.id === job.id)?.status !== 'downloading'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  manager.cancel(job.id)
  expect((await settle(manager, job.id)).status).toBe('cancelled')
  expect((await readdir(folder)).filter(name => name.startsWith('.mustplay-'))).toEqual([])
  manager.dispose()
})

it('reports an error for an unsupported codec and leaves no file behind', async () => {
  const manager = new YandexDownloads(() => undefined, () => fakeApi({ audio: Buffer.alloc(16), info: { codec: 'vorbis' } }))
  const job = manager.enqueue('123', config(), { title: '', artist: null })
  const settled = await settle(manager, job.id)
  expect(settled.status).toBe('error')
  expect(settled.error).toContain('кодек')
  expect((await readdir(folder)).filter(name => name.startsWith('.mustplay-'))).toEqual([])
  manager.dispose()
})