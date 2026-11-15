import { describe, expect, it } from 'vitest'
import { parseDeezerPlaylist, parseDeezerSearch, pickDeezerTrack } from '../src/metadata/providers/deezer'
import { parseSpotifyEmbed } from '../src/metadata/providers/spotify-embed'
import { rankMusicBrainzCandidates } from '../src/metadata/musicbrainz'
import {
  buildYtMusicContinuationRequest, mergeYtMusicTracks, parseYtMusicConfig, parseYtMusicContinuation,
  parseYtMusicItem, parseYtMusicPage, parseYtMusicPlaylist, parseYtMusicPlaylistId,
} from '../src/metadata/providers/ytmusic'
import { parseSpotifyPage } from '../src/metadata/providers/spotify'
import { parsePlaylistUrl } from '../src/metadata/providers/types'
import { buildSearchQuery, describeYtDlpFailure, downloadArguments, parseDownloadedPath, parseSearchOutput } from '../src/audio/ytdlp'
import { AcoustidKeyError, Fingerprinter } from '../src/pipeline/fingerprint'
import { retry } from '../src/pipeline/limiter'
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

describe('metadata resolution for sources without ISRC', () => {
  it('reads the public Spotify embed page without an account', () => {
    const payload = {
      props: {
        pageProps: {
          state: {
            data: {
              entity: {
                type: 'playlist',
                name: 'Mix',
                trackList: [
                  { uri: 'spotify:track:abc', title: 'Midnight City', subtitle: 'M83', duration: 244_000, entityType: 'track' },
                  { uri: 'spotify:episode:x', title: 'Episode', subtitle: 'Podcast', duration: 1_000, entityType: 'episode' },
                  { uri: 'spotify:track:def', title: 'No Duration', subtitle: '' },
                ],
              },
            },
          },
        },
      },
    }
    const playlist = parseSpotifyEmbed(
      `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></html>`,
    )
    expect(playlist).not.toBeNull()
    expect(playlist!.name).toBe('Mix')
    expect(playlist!.tracks).toHaveLength(2)
    expect(playlist!.tracks[0]).toMatchObject({
      title: 'Midnight City', artist: 'M83', durationSeconds: 244, isrc: null, providerId: 'abc',
    })
    expect(playlist!.tracks[1]).toMatchObject({ title: 'No Duration', durationSeconds: null, providerId: 'def' })
    expect(parseSpotifyEmbed('<html>no data</html>')).toBeNull()
  })

  it('picks the Deezer row that carries a matching ISRC', () => {
    const picked = pickDeezerTrack(
      { title: 'Midnight City', artist: 'M83', durationSeconds: 244 },
      [
        { id: 1, title: 'Midnight City (Remix)', duration: 300, isrc: 'FRU661100999', artist: { name: 'M83' } },
        { id: 2, title: 'Midnight City', duration: 244, isrc: 'FRU661100171', artist: { name: 'M83' } },
        { id: 3, title: 'Midnight City', duration: 244, artist: { name: 'M83' } },
      ],
    )
    expect(picked).toMatchObject({ isrc: 'FRU661100171', providerId: '2' })
    expect(pickDeezerTrack({ title: 'Other', artist: 'Nobody', durationSeconds: 100 }, [
      { id: 4, title: 'Midnight City', duration: 244, isrc: 'FRU661100171', artist: { name: 'M83' } },
    ])).toBeNull()
  })

  it('ranks MusicBrainz candidates by title, artist and duration', () => {
    const ranked = rankMusicBrainzCandidates(
      { title: 'Midnight City', artist: 'M83', durationSeconds: 244 },
      {
        recordings: [
          { id: 'wrong', title: 'Midnight City', length: 300_000, 'artist-credit': [{ name: 'Other Band' }] },
          { id: 'right', title: 'Midnight City', length: 244_000, 'artist-credit': [{ name: 'M83' }] },
        ],
      },
    )
    expect(ranked.map(recording => recording.id)).toEqual(['right', 'wrong'])
  })
})

describe('YT Music playlist parsing', () => {
  const item = {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: 'abc12345678' },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Midnight City' }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'M83' }, { text: ' • ' }, { text: 'Hurry Up' }] } } },
      ],
      fixedColumns: [
        { musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '4:04' }] } } },
      ],
    },
  }

  it('maps a YT Music row to a direct audio source', () => {
    expect(parseYtMusicItem(item)).toMatchObject({
      title: 'Midnight City', artist: 'M83', durationSeconds: 244, isrc: null,
      providerId: 'abc12345678', sourceUrl: 'https://www.youtube.com/watch?v=abc12345678',
    })
    expect(parseYtMusicItem({ musicResponsiveListItemRenderer: { flexColumns: [] } })).toBeNull()
  })

  it('reads the shelf, the playlist name and the continuation token', () => {
    const page = parseYtMusicPlaylist({
      header: { musicDetailHeaderRenderer: { title: { runs: [{ text: 'My Mix' }] } } },
      contents: {
        sectionListRenderer: {
          contents: [{
            musicPlaylistShelfRenderer: {
              contents: [
                item,
                { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN' } } } },
              ],
            },
          }],
        },
      },
    })
    expect(page).toMatchObject({ name: 'My Mix', continuation: 'TOKEN' })
    expect(page.tracks).toHaveLength(1)
  })

  it('reads continuation pages and drops duplicate videos', () => {
    const next = parseYtMusicContinuation({
      continuationContents: {
        musicPlaylistShelfContinuation: {
          contents: [item, {
            musicResponsiveListItemRenderer: {
              playlistItemData: { videoId: 'def12345678' },
              flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Another' }] } } }],
            },
          }],
          continuations: [{ nextContinuationData: { continuation: 'NEXT' } }],
        },
      },
    })
    expect(next.continuation).toBe('NEXT')
    expect(next.tracks).toHaveLength(2)
    const first = parseYtMusicItem(item)!
    expect(mergeYtMusicTracks([first], next.tracks).map(track => track.providerId))
      .toEqual(['abc12345678', 'def12345678'])
  })

  it('reads the page config and builds the continuation request', () => {
    const html = [
      '<script>ytcfg.set({"INNERTUBE_API_KEY":"KEY","INNERTUBE_CLIENT_VERSION":"1.2",',
      '"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB_REMIX","clientVersion":"1.2"}}});</script>',
      '<script>var ytInitialData = {"contents":{}};</script>',
    ].join('')
    const page = parseYtMusicPage(html)
    expect(page.initialData).toEqual({ contents: {} })
    expect(parseYtMusicConfig(html)).toMatchObject({ apiKey: 'KEY', clientVersion: '1.2' })
    const request = buildYtMusicContinuationRequest(page.config, 'TOKEN')
    expect(request.url).toContain('key=KEY')
    expect(JSON.parse(request.body)).toMatchObject({
      context: { client: { clientName: 'WEB_REMIX' } }, continuation: 'TOKEN',
    })
  })

  it('accepts playlist links only', () => {
    expect(parseYtMusicPlaylistId('https://music.youtube.com/playlist?list=PLabc123456')).toBe('PLabc123456')
    expect(parseYtMusicPlaylistId('https://music.youtube.com/watch?v=abc&list=PLabc123456')).toBe('PLabc123456')
    expect(parseYtMusicPlaylistId('https://music.youtube.com/')).toBeNull()
    expect(parseYtMusicPlaylistId('https://example.com/playlist?list=PLabc123456')).toBeNull()
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

  it('downloads a direct source without searching and adds a reference ISRC', async () => {
    const downloaded: string[] = []
    const outcome = await runTrack({
      title: 'Midnight City', artist: 'M83', album: null, durationSeconds: 244,
      isrc: null, providerId: 'yt123', sourceUrl: 'https://www.youtube.com/watch?v=yt123',
    }, {
      cachedFile: async () => null,
      resolveIsrc: async () => null,
      resolveTrack: async input => ({ ...input, isrc: 'FRU661100171' }),
      search: async () => { throw new Error('search must not run for a direct source') },
      download: async candidate => { downloaded.push(candidate.url); return 'C:/music/direct.webm' },
      fingerprint: async () => ({ durationSeconds: 244, fingerprint: 'FP' }),
      lookupAcoustid: async () => [{
        recordingId: 'r', title: 'Midnight City', artist: 'M83', durationSeconds: 244,
        isrcs: ['FRU661100171'], score: 0.9,
      }],
      remember: async () => {},
      discard: async () => {},
      update: () => {},
      isCancelled: () => false,
    })
    expect(downloaded).toEqual(['https://www.youtube.com/watch?v=yt123'])
    expect(outcome).toMatchObject({ status: 'verified', method: 'isrc', filePath: 'C:/music/direct.webm' })
  })
})

describe('diagnostics for a broken import', () => {
  const withFetch = async <T>(response: () => Response, task: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => response()) as typeof fetch
    try {
      return await task()
    } finally {
      globalThis.fetch = original
    }
  }

  it('turns a rejected AcoustID key into an actionable error', async () => {
    const fingerprinter = new Fingerprinter('fpcalc')
    const error = await withFetch(
      () => new Response(JSON.stringify({ status: 'error', error: { code: 4, message: 'invalid API key' } }), { status: 400 }),
      () => fingerprinter.lookup('KEY', { durationSeconds: 244, fingerprint: 'FP' }).then(
        () => null,
        (failure: unknown) => failure,
      ),
    )
    expect(error).toBeInstanceOf(AcoustidKeyError)
    expect((error as Error).message).toContain('acoustid.org/new-application')
  })

  it('keeps the AcoustID message for other failures', async () => {
    const fingerprinter = new Fingerprinter('fpcalc')
    const error = await withFetch(
      () => new Response('', { status: 500 }),
      () => fingerprinter.lookup('KEY', { durationSeconds: 244, fingerprint: 'FP' }).then(
        () => null,
        (failure: unknown) => failure,
      ),
    )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(AcoustidKeyError)
    expect((error as Error).message).toBe('AcoustID: HTTP 500')
  })

  it('asks AcoustID for recordings with their ISRCs', async () => {
    const fingerprinter = new Fingerprinter('fpcalc')
    let requestBody = ''
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = String(init?.body ?? '')
      return new Response(JSON.stringify({ status: 'ok', results: [] }), { status: 200 })
    }) as typeof fetch
    try {
      await fingerprinter.lookup('KEY', { durationSeconds: 244, fingerprint: 'FP' })
    } finally {
      globalThis.fetch = original
    }
    const params = new URLSearchParams(requestBody)
    // AcoustID splits `meta` on whitespace; a literal "+" silently returns
    // results without recordings, which looks like "nothing matched".
    expect(params.get('meta')).toBe('recordings isrcs')
    expect(params.get('client')).toBe('KEY')
    expect(params.get('fingerprint')).toBe('FP')
    expect(params.get('duration')).toBe('244')
  })

  it('does not retry a permanent failure', async () => {
    let calls = 0
    await expect(retry(async () => {
      calls++
      throw new AcoustidKeyError()
    }, 3, 1, error => !(error instanceof AcoustidKeyError))).rejects.toBeInstanceOf(AcoustidKeyError)
    expect(calls).toBe(1)
  })

  it('explains when yt-dlp cannot reach YouTube', () => {
    const blocked = describeYtDlpFailure(new Error(
      'ERROR: Unable to download API page: [SSL: INVALID_SESSION_ID] invalid session id',
    ))
    expect((blocked as Error).message).toContain('YouTube недоступен из этой сети')
    const other = new Error('ERROR: Unsupported URL: https://example.com')
    expect(describeYtDlpFailure(other)).toBe(other)
  })
})
