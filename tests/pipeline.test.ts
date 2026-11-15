import { describe, expect, it } from 'vitest'
import { parseDeezerPlaylist, parseDeezerSearch } from '../src/metadata/providers/deezer'
import { parseSpotifyPage } from '../src/metadata/providers/spotify'
import { parsePlaylistUrl } from '../src/metadata/providers/types'
import { buildSearchQuery, downloadArguments, parseDownloadedPath, parseSearchOutput } from '../src/audio/ytdlp'
import { judgeFingerprint, pickCandidate } from '../src/pipeline/match'
import { runTrack } from '../src/pipeline/orchestrator'
import type { AudioCandidate, PipelineTrackInput } from '../src/shared/pipeline'

const track: PipelineTrackInput = {
  title: 'Midnight City',
  artist: 'M83',
  album: 'Hurry Up, We’re Dreaming',
  durationSeconds: 244,
  isrc: 'FRU661100171',
  providerId: 'deezer-1',
}

describe('playlist links', () => {
  it('recognises Deezer and Spotify playlists', () => {
    expect(parsePlaylistUrl('https://www.deezer.com/ru/playlist/1234567')).toMatchObject({
      provider: 'deezer', id: '1234567',
    })
    expect(parsePlaylistUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc')).toMatchObject({
      provider: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M',
    })
    expect(parsePlaylistUrl('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toMatchObject({
      provider: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M',
    })
  })

  it('ignores unsupported and malformed links', () => {
    expect(parsePlaylistUrl('https://example.com/playlist/1')).toBeNull()
    expect(parsePlaylistUrl('')).toBeNull()
    expect(parsePlaylistUrl(`https://open.spotify.com/playlist/${'a'.repeat(3000)}`)).toBeNull()
  })
})

describe('provider parsing', () => {
  it('maps Deezer tracks and keeps ISRC', () => {
    const playlist = parseDeezerPlaylist({
      title: 'Mix',
      tracks: {
        data: [
          { id: 1, title: 'Midnight City', duration: 244, isrc: 'fru661100171', artist: { name: 'M83' }, album: { title: 'Hurry Up' } },
          { id: 2, title: '   ' },
        ],
      },
    })
    expect(playlist.name).toBe('Mix')
    expect(playlist.tracks).toHaveLength(1)
    expect(playlist.tracks[0]).toMatchObject({
      title: 'Midnight City', artist: 'M83', album: 'Hurry Up', durationSeconds: 244,
      isrc: 'FRU661100171', providerId: '1',
    })
  })

  it('resolves ISRC through the Deezer search payload', () => {
    expect(parseDeezerSearch({ data: [{ id: 7, title: 'Song', isrc: 'USRC17607839', artist: { name: 'A' } }] }))
      .toMatchObject({ title: 'Song', isrc: 'USRC17607839' })
  })

  it('maps Spotify pages and skips podcast episodes', () => {
    const page = parseSpotifyPage({
      name: 'Mix',
      next: null,
      items: [
        { track: { id: 't1', name: 'Midnight City', type: 'track', duration_ms: 244_000, external_ids: { isrc: 'FRU661100171' }, artists: [{ name: 'M83' }], album: { name: 'Hurry Up' } } },
        { track: { id: 'e1', name: 'Episode', type: 'episode', duration_ms: 100_000, artists: [] } },
        { track: null },
      ],
    })
    expect(page.tracks).toHaveLength(1)
    expect(page.tracks[0]).toMatchObject({ title: 'Midnight City', artist: 'M83', durationSeconds: 244 })
  })
})

describe('yt-dlp helpers', () => {
  it('builds a search query from artist and title', () => {
    expect(buildSearchQuery({ title: 'Song', artist: 'Artist' })).toBe('Artist - Song')
    expect(buildSearchQuery({ title: 'Song', artist: null })).toBe('Song')
  })

  it('asks for the best audio stream without transcoding', () => {
    const args = downloadArguments('https://youtu.be/x', 'C:/music')
    expect(args).toContain('bestaudio/best')
    expect(args.join(' ')).toContain('after_move:filepath')
  })

  it('parses a flat search payload', () => {
    const candidates = parseSearchOutput(JSON.stringify({
      entries: [
        { id: 'abc', title: 'M83 - Midnight City', duration: 244, uploader: 'M83' },
        { id: 'def' },
        null,
      ],
    }))
    expect(candidates).toEqual([{
      id: 'abc', url: 'https://www.youtube.com/watch?v=abc', title: 'M83 - Midnight City',
      channel: 'M83', durationSeconds: 244,
    }])
  })

  it('reads the downloaded file path from yt-dlp output', () => {
    expect(parseDownloadedPath('C:\\music\\M83 - Midnight City [abc].webm')).toBe('C:\\music\\M83 - Midnight City [abc].webm')
    expect(parseDownloadedPath('/home/user/M83 - Midnight City [abc].webm')).toBe('/home/user/M83 - Midnight City [abc].webm')
    expect(parseDownloadedPath('random log line')).toBeNull()
  })
})

describe('candidate matching', () => {
  const candidates: AudioCandidate[] = [
    { id: '1', url: 'https://a', title: 'M83 - Midnight City (Official Video)', channel: 'M83', durationSeconds: 244 },
    { id: '2', url: 'https://b', title: 'Some other song', channel: 'Radio', durationSeconds: 90 },
  ]

  it('prefers the matching title and duration', () => {
    expect(pickCandidate(track, candidates)?.id).toBe('1')
  })

  it('rejects a weak pool', () => {
    expect(pickCandidate(track, [candidates[1]!])).toBeNull()
  })
})

describe('fingerprint verdicts', () => {
  it('verifies when AcoustID reports the same ISRC', () => {
    const verdict = judgeFingerprint(track, [{
      recordingId: 'r', title: 'Midnight City', artist: 'M83', durationSeconds: 244,
      isrcs: ['FRU661100171'], score: 0.31,
    }], 244)
    expect(verdict.status).toBe('verified')
    expect(verdict.method).toBe('isrc')
  })

  it('verifies a strong AcoustID match without ISRC', () => {
    const verdict = judgeFingerprint({ ...track, isrc: null }, [{
      recordingId: 'r', title: 'Midnight City', artist: 'M83', durationSeconds: 244,
      isrcs: [], score: 0.97,
    }], 244)
    expect(verdict.status).toBe('verified')
    expect(verdict.method).toBe('acoustid')
  })

  it('rejects a different recording', () => {
    const verdict = judgeFingerprint({ ...track, isrc: null }, [{
      recordingId: 'r', title: 'Unrelated Track', artist: 'Another Artist', durationSeconds: 244,
      isrcs: [], score: 0.4,
    }], 244)
    expect(verdict.status).toBe('rejected')
  })
})

describe('track pipeline dry run', () => {
  it('verifies a matching download and remembers it', async () => {
    const remembered: string[] = []
    const discarded: string[] = []
    const outcome = await runTrack(track, {
      cachedFile: async () => null,
      resolveIsrc: async () => track,
      search: async () => [{ id: '1', url: 'https://a', title: 'M83 - Midnight City', channel: 'M83', durationSeconds: 244 }],
      download: async () => 'C:/music/track.webm',
      fingerprint: async () => ({ durationSeconds: 244, fingerprint: 'FP' }),
      lookupAcoustid: async () => [{
        recordingId: 'r', title: 'Midnight City', artist: 'M83', durationSeconds: 244,
        isrcs: ['FRU661100171'], score: 0.95,
      }],
      remember: async (_track, filePath) => { remembered.push(filePath) },
      discard: async filePath => { discarded.push(filePath) },
      update: () => {},
      isCancelled: () => false,
    })
    expect(outcome).toMatchObject({ status: 'verified', method: 'isrc', filePath: 'C:/music/track.webm' })
    expect(remembered).toEqual(['C:/music/track.webm'])
    expect(discarded).toEqual([])
  })

  it('deletes a download that does not match', async () => {
    const discarded: string[] = []
    const outcome = await runTrack({ ...track, isrc: null }, {
      cachedFile: async () => null,
      resolveIsrc: async () => null,
      search: async () => [{ id: '1', url: 'https://a', title: 'M83 - Midnight City', channel: 'M83', durationSeconds: 244 }],
      download: async () => 'C:/music/track.webm',
      fingerprint: async () => ({ durationSeconds: 244, fingerprint: 'FP' }),
      lookupAcoustid: async () => [{
        recordingId: 'r', title: 'Unrelated', artist: 'Nobody', durationSeconds: 244, isrcs: [], score: 0.2,
      }],
      remember: async () => {},
      discard: async filePath => { discarded.push(filePath) },
      update: () => {},
      isCancelled: () => false,
    })
    expect(outcome.status).toBe('rejected')
    expect(discarded).toEqual(['C:/music/track.webm'])
  })
})
