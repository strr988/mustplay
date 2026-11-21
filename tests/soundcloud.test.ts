import { describe, expect, it, vi } from 'vitest'
import type { PipelineTrackInput } from '../src/shared/pipeline'
import { ProcessError } from '../src/audio/process'
import {
  isDrmFailure, isNetworkFailure, parsePlaylistOutput, parseTrackOutput,
} from '../src/audio/ytdlp'
import { readSoundCloudSet } from '../src/pipeline/soundcloud'
import type { SoundCloudReader } from '../src/pipeline/soundcloud'

const setUrl = 'https://soundcloud.com/forss/sets/soulhack'

function track(title: string, extra: Partial<PipelineTrackInput> = {}): PipelineTrackInput {
  return {
    title,
    artist: 'Artist',
    album: null,
    durationSeconds: 180,
    isrc: null,
    providerId: title,
    sourceUrl: `https://soundcloud.com/forss/${title}`,
    ...extra,
  }
}

function drmError(): ProcessError {
  return new ProcessError('yt-dlp', 1, 'ERROR: [soundcloud] 123: DRM protected: this track is not available', '')
}

function readerWith(overrides: Partial<SoundCloudReader> = {}): SoundCloudReader {
  return {
    playlist: vi.fn(async () => ({ name: 'Soulhack', tracks: [track('one')] })),
    track: vi.fn(async () => track('one')),
    ...overrides,
  }
}

describe('SoundCloud set reading', () => {
  it('uses the fast full read when nothing is broken', async () => {
    const reader = readerWith()
    const result = await readSoundCloudSet(setUrl, reader)
    expect(reader.playlist).toHaveBeenCalledTimes(1)
    expect(reader.playlist).toHaveBeenCalledWith(setUrl, { flat: false, limit: 100 })
    expect(reader.track).not.toHaveBeenCalled()
    expect(result.tracks.map(item => item.title)).toEqual(['one'])
    expect(result.note).toBe('Публичная страница SoundCloud: 1 трек.')
  })

  it('reports records yt-dlp skipped in the fast path', async () => {
    const reader = readerWith({
      playlist: vi.fn(async () => ({
        name: 'Soulhack',
        tracks: [track('one'), track('two')],
        expectedCount: 3,
      })),
    })
    const result = await readSoundCloudSet(setUrl, reader)
    expect(result.tracks).toHaveLength(2)
    expect(result.skipped).toBe(1)
    expect(result.note).toContain('2 из 3 треков')
    expect(result.note).toContain('1 пропущено')
    // No second request: the fast path already produced a usable list.
    expect(reader.playlist).toHaveBeenCalledTimes(1)
  })

  it('names DRM when the fast path reported it', async () => {
    const reader = readerWith({
      playlist: vi.fn(async () => ({
        name: 'Soulhack',
        tracks: [track('one'), track('two')],
        expectedCount: 3,
        skippedDrm: true,
      })),
    })
    const result = await readSoundCloudSet(setUrl, reader)
    expect(result.skippedDrm).toBe(1)
    expect(result.note).toContain('1 пропущено (DRM)')
  })

  it('falls back to a flat list when the full read hits DRM', async () => {
    // The user-facing disaster: one DRM record aborted the whole set.
    const playlist = vi.fn()
      .mockRejectedValueOnce(drmError())
      .mockResolvedValueOnce({
        name: 'Soulhack',
        tracks: [track('one'), track('two'), track('three')],
      })
    const trackReader = vi.fn(async (url: string) => {
      if (url.endsWith('/two')) throw drmError()
      return track(url.endsWith('/three') ? 'three' : 'one')
    })
    const result = await readSoundCloudSet(setUrl, { playlist, track: trackReader })

    expect(playlist).toHaveBeenNthCalledWith(1, setUrl, { flat: false, limit: 100 })
    expect(playlist).toHaveBeenNthCalledWith(2, setUrl, { flat: true, limit: 500 })
    expect(result.tracks.map(item => item.title).sort()).toEqual(['one', 'three'])
    expect(result.skippedDrm).toBe(1)
    expect(result.skippedOther).toBe(0)
    expect(result.note).toContain('2 из 3 треков')
    expect(result.note).toContain('1 пропущено (DRM)')
  })

  it('isolates a broken record instead of losing the set', async () => {
    const playlist = vi.fn()
      .mockRejectedValueOnce(new Error('Unable to extract set'))
      .mockResolvedValueOnce({ name: 'Soulhack', tracks: [track('one'), track('two')] })
    const trackReader = vi.fn(async (url: string) => {
      if (url.endsWith('/two')) throw new Error('HTTP Error 404: Not Found')
      return track('one')
    })
    const result = await readSoundCloudSet(setUrl, { playlist, track: trackReader })
    expect(result.tracks.map(item => item.title)).toEqual(['one'])
    expect(result.skippedOther).toBe(1)
    expect(result.note).toContain('1 не удалось прочитать')
  })

  it('explains a set where every record is DRM protected', async () => {
    const playlist = vi.fn()
      .mockRejectedValueOnce(drmError())
      .mockResolvedValueOnce({ name: 'Soulhack', tracks: [track('one'), track('two')] })
    const trackReader = vi.fn(async () => { throw drmError() })
    await expect(readSoundCloudSet(setUrl, { playlist, track: trackReader }))
      .rejects.toThrow('все треки защищены DRM')
  })

  it('reports an unreachable service without trying the fallback', async () => {
    const playlist = vi.fn()
      .mockRejectedValue(new ProcessError('yt-dlp', 1, 'getaddrinfo ENOTFOUND api-v2.soundcloud.com', ''))
    await expect(readSoundCloudSet(setUrl, { playlist, track: vi.fn() }))
      .rejects.toThrow('getaddrinfo ENOTFOUND')
    expect(playlist).toHaveBeenCalledTimes(1)
  })

  it('reports an empty set', async () => {
    const playlist = vi.fn()
      .mockResolvedValueOnce({ name: 'Soulhack', tracks: [] })
      .mockResolvedValueOnce({ name: 'Soulhack', tracks: [] })
    await expect(readSoundCloudSet(setUrl, { playlist, track: vi.fn() }))
      .rejects.toThrow('не нашлось треков')
  })

  it('keeps at most four per-record requests in flight', async () => {
    const entries = Array.from({ length: 9 }, (_, index) => track(`t${index}`))
    const playlist = vi.fn()
      .mockRejectedValueOnce(drmError())
      .mockResolvedValueOnce({ name: 'Soulhack', tracks: entries })
    let inFlight = 0
    let peak = 0
    const trackReader = vi.fn(async (url: string) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 2))
      inFlight--
      return track(url.split('/').pop() ?? 'unknown')
    })
    const result = await readSoundCloudSet(setUrl, { playlist, track: trackReader }, { concurrency: 4 })
    expect(result.tracks).toHaveLength(9)
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('keeps flat metadata when a resolved page has less', async () => {
    const entry = track('one', { album: 'Flat album', durationSeconds: 240 })
    const playlist = vi.fn()
      .mockRejectedValueOnce(drmError())
      .mockResolvedValueOnce({ name: 'Soulhack', tracks: [entry] })
    const trackReader = vi.fn(async () => ({
      title: '', artist: null, album: null, durationSeconds: null, isrc: null, providerId: null,
    }))
    const result = await readSoundCloudSet(setUrl, { playlist, track: trackReader })
    expect(result.tracks[0]).toMatchObject({
      title: 'one',
      album: 'Flat album',
      durationSeconds: 240,
      sourceUrl: entry.sourceUrl,
    })
  })
})

describe('yt-dlp playlist and track parsing', () => {
  it('derives a readable title from a flat SoundCloud URL', () => {
    const parsed = parsePlaylistOutput(JSON.stringify({
      title: 'Soulhack',
      entries: [
        null,
        { id: '2' },
        { id: '1', url: 'https://soundcloud.com/forss/soulhack' },
      ],
    }))
    expect(parsed?.name).toBe('Soulhack')
    expect(parsed?.tracks.map(item => item.title)).toEqual(['Soulhack'])
  })

  it('reads a fully resolved track', () => {
    const parsed = parseTrackOutput(JSON.stringify({
      id: '123',
      webpage_url: 'https://soundcloud.com/forss/soulhack',
      title: 'Soulhack',
      uploader: 'Forss',
      album: 'Soulhack',
      genre: 'Electronic',
      duration: 245.5,
    }))
    expect(parsed).toMatchObject({
      title: 'Soulhack',
      artist: 'Forss',
      album: 'Soulhack',
      genres: ['Electronic'],
      durationSeconds: 245.5,
      providerId: '123',
      sourceUrl: 'https://soundcloud.com/forss/soulhack',
    })
  })

  it('splits "Artist - Title" when the page has no uploader', () => {
    const parsed = parseTrackOutput(JSON.stringify({
      id: '1',
      webpage_url: 'https://soundcloud.com/forss/soulhack',
      title: 'Forss - Soulhack',
    }))
    expect(parsed).toMatchObject({ title: 'Soulhack', artist: 'Forss' })
  })

  it('returns null on empty or broken output', () => {
    expect(parseTrackOutput('')).toBeNull()
    expect(parseTrackOutput('not json')).toBeNull()
    expect(parseTrackOutput('{"title":"x"}')).toBeNull()
    expect(parseTrackOutput('null')).toBeNull()
    expect(parsePlaylistOutput('null')).toBeNull()
    expect(parsePlaylistOutput('{"entries":null}')).toBeNull()
  })

  it('recognises DRM and network failures separately', () => {
    expect(isDrmFailure(drmError())).toBe(true)
    expect(isNetworkFailure(drmError())).toBe(false)
    const network = new ProcessError('yt-dlp', 1, 'getaddrinfo ENOTFOUND api-v2.soundcloud.com', '')
    expect(isNetworkFailure(network)).toBe(true)
    expect(isDrmFailure(network)).toBe(false)
    expect(isDrmFailure(new Error('Трек защищён DRM в источнике'))).toBe(true)
  })
})
