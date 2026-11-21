import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { containerForCodec, writeTags } from '../src/main/yandex-tags'
import type { TrackTags } from '../src/main/yandex-tags'
import { matchesAudioFormat } from '../src/main/audio-formats'
import type { AudioFormat } from '../src/shared/contracts'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url))
let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'mustplay-tags-'))
})
afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

const tags: TrackTags = {
  title: 'Тестовая композиция',
  album: 'Тестовый альбом',
  artists: ['Исполнитель А', 'Исполнитель Б'],
  albumArtists: ['Альбомный исполнитель'],
  date: '2024',
  trackNumber: 3,
  discNumber: 1,
  genre: 'Electronic',
  lyrics: 'Уникальная строка текста песни mustplay',
  comment: 'https://music.yandex.ru/album/1/track/2',
  cover: null,
}

function lyricsText(metadata: Awaited<ReturnType<typeof parseFile>>): string {
  const parts: string[] = []
  for (const entry of metadata.common.lyrics ?? []) {
    if (typeof entry === 'string') parts.push(entry)
    else parts.push(entry.text ?? '', ...(entry.syncText ?? []).map(line => line.text))
  }
  for (const { id, value } of metadata.native.vorbis ?? []) {
    if (/LYRICS/i.test(id) && typeof value === 'string') parts.push(value)
  }
  return parts.join('\n')
}

async function roundTrip(name: string, container: 'mp3' | 'flac' | 'm4a', format: AudioFormat, coverMime: 'image/jpeg' | 'image/png', coverName: string) {
  const [audio, cover] = await Promise.all([fixture(name), fixture(coverName)])
  const withCover: TrackTags = { ...tags, cover: { data: cover, mime: coverMime } }
  const tagged = writeTags(container, audio, withCover)
  const path = join(folder, `tagged.${container === 'm4a' ? 'm4a' : container}`)
  await writeFile(path, tagged)
  const metadata = await parseFile(path)
  expect(metadata.common.title).toBe(tags.title)
  expect(metadata.common.album).toBe(tags.album)
  expect(metadata.common.artist).toContain('Исполнитель А')
  expect(metadata.common.albumartist).toContain('Альбомный исполнитель')
  expect(metadata.common.year).toBe(2024)
  expect(metadata.common.track.no).toBe(3)
  expect(metadata.common.disk.no).toBe(1)
  expect(metadata.common.genre?.[0]).toBe('Electronic')
  expect(lyricsText(metadata)).toContain('Уникальная строка текста песни mustplay')
  expect(Buffer.from(metadata.common.picture![0].data)).toEqual(cover)
  expect(metadata.format.duration).toBeGreaterThan(0)
  expect(matchesAudioFormat(format, metadata.format.container!.toLowerCase(), metadata.format)).toBe(true)
  // Tagging twice replaces the previous tag instead of duplicating it.
  const retagged = writeTags(container, tagged, { ...withCover, title: 'Новое название' })
  const rePath = join(folder, `retagged.${container === 'm4a' ? 'm4a' : container}`)
  await writeFile(rePath, retagged)
  const reMetadata = await parseFile(rePath)
  expect(reMetadata.common.title).toBe('Новое название')
  expect(reMetadata.common.picture?.length).toBe(1)
  expect(reMetadata.format.duration).toBeGreaterThan(0)
}

it('writes ID3v2.3 tags into MP3 and keeps audio playable', async () => {
  await roundTrip('01-tone.mp3', 'mp3', 'mp3', 'image/jpeg', 'cover.jpg')
})

it('writes Vorbis comments and a picture into FLAC', async () => {
  await roundTrip('02-tone.flac', 'flac', 'flac', 'image/png', 'cover.png')
})

it('writes ilst atoms into AAC M4A and fixes chunk offsets', async () => {
  await roundTrip('formats/tone.m4a', 'm4a', 'm4a', 'image/jpeg', 'cover.jpg')
})

it('writes ilst atoms into FLAC-in-M4A', async () => {
  await roundTrip('formats/tone.flac.m4a', 'm4a', 'm4a', 'image/png', 'cover.png')
})

it('maps codecs to containers and extensions', () => {
  expect(containerForCodec('flac')).toEqual({ container: 'flac', extension: '.flac' })
  expect(containerForCodec('flac-mp4')).toEqual({ container: 'm4a', extension: '.m4a' })
  expect(containerForCodec('mp3')).toEqual({ container: 'mp3', extension: '.mp3' })
  expect(containerForCodec('aac-mp4')).toEqual({ container: 'm4a', extension: '.m4a' })
  expect(containerForCodec('unknown')).toBeNull()
})