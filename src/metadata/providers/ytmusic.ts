import type { PipelineTrackInput } from '../../shared/pipeline'

/**
 * YT Music has no public API. The embedded browser session gives us the same
 * `ytInitialData` JSON the page renders, plus continuation tokens for pages
 * beyond the first screen. Everything here is pure so it can be tested with
 * captured payloads.
 */

export interface YtMusicPlaylistPage {
  name: string | null
  tracks: PipelineTrackInput[]
  continuation: string | null
}

export interface YtMusicClientConfig {
  apiKey: string | null
  context: unknown
  clientVersion: string | null
}

interface JsonObject { [key: string]: unknown }

const maxNodes = 20_000
const maxPages = 40
const maxTracks = 1_000

export const ytMusicContinuationUrl = 'https://music.youtube.com/youtubei/v1/browse'

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Breadth-first search that tolerates the deeply nested YouTube payloads. */
function findNodes(root: unknown, predicate: (node: JsonObject) => boolean, limit = 50): JsonObject[] {
  const found: JsonObject[] = []
  const queue: unknown[] = [root]
  let visited = 0
  while (queue.length && visited < maxNodes && found.length < limit) {
    const node = queue.shift()
    visited++
    if (Array.isArray(node)) {
      for (const child of node) if (child && typeof child === 'object') queue.push(child)
      continue
    }
    if (!isObject(node)) continue
    if (predicate(node)) found.push(node)
    for (const child of Object.values(node)) {
      if (child && typeof child === 'object') queue.push(child)
    }
  }
  return found
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!isObject(value)) return ''
  if (typeof value.simpleText === 'string') return value.simpleText
  if (Array.isArray(value.runs)) {
    return value.runs.map(run => (isObject(run) && typeof run.text === 'string' ? run.text : '')).join('')
  }
  return ''
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function parseDuration(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,3}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const hours = match[1] ? Number(match[1]) : 0
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  const total = hours * 3600 + minutes * 60 + seconds
  return total > 0 ? total : null
}

function byline(value: unknown): string | null {
  const text = cleanText(textOf(value))
  if (!text) return null
  const first = text.split('•')[0]?.trim()
  return first ? first.slice(0, 300) : null
}

function videoIdOf(renderer: JsonObject): string | null {
  const data = renderer.playlistItemData
  if (isObject(data) && typeof data.videoId === 'string' && data.videoId) return data.videoId
  if (typeof renderer.videoId === 'string' && renderer.videoId) return renderer.videoId
  const navigation = renderer.navigationEndpoint
  if (isObject(navigation) && isObject(navigation.watchEndpoint) &&
      typeof navigation.watchEndpoint.videoId === 'string' && navigation.watchEndpoint.videoId) {
    return navigation.watchEndpoint.videoId
  }
  return null
}

/** Reads one playlist row from either row renderer YouTube currently uses. */
export function parseYtMusicItem(item: unknown): PipelineTrackInput | null {
  if (!isObject(item)) return null
  const renderer = isObject(item.musicResponsiveListItemRenderer)
    ? item.musicResponsiveListItemRenderer
    : isObject(item.playlistVideoRenderer) ? item.playlistVideoRenderer : null
  if (!renderer) return null
  const videoId = videoIdOf(renderer)
  if (!videoId) return null
  const columns = Array.isArray(renderer.flexColumns) ? renderer.flexColumns : []
  const titleColumn = isObject(columns[0]) && isObject(columns[0].musicResponsiveListItemFlexColumnRenderer)
    ? columns[0].musicResponsiveListItemFlexColumnRenderer.text
    : undefined
  const artistColumn = isObject(columns[1]) && isObject(columns[1].musicResponsiveListItemFlexColumnRenderer)
    ? columns[1].musicResponsiveListItemFlexColumnRenderer.text
    : undefined
  const title = cleanText(textOf(titleColumn) || textOf(renderer.title))
  if (!title) return null
  const artist = byline(artistColumn) ?? byline(renderer.shortBylineText) ?? byline(renderer.longBylineText)
  const fixed = Array.isArray(renderer.fixedColumns) && isObject(renderer.fixedColumns[0]) &&
    isObject(renderer.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer)
    ? renderer.fixedColumns[0].musicResponsiveListItemFixedColumnRenderer.text
    : undefined
  const duration = parseDuration(textOf(fixed) || textOf(renderer.lengthText))
  return {
    title: title.slice(0, 300),
    artist: artist ?? null,
    album: null,
    durationSeconds: duration,
    isrc: null,
    providerId: videoId,
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
  }
}

function shelfContents(payload: unknown): { contents: unknown[]; continuation: string | null } {
  const shelves = findNodes(payload, node =>
    isObject(node.musicPlaylistShelfRenderer) || isObject(node.musicPlaylistShelfContinuation))
  const contents: unknown[] = []
  let continuation: string | null = null
  for (const shelf of shelves) {
    const renderer = isObject(shelf.musicPlaylistShelfRenderer)
      ? shelf.musicPlaylistShelfRenderer
      : shelf.musicPlaylistShelfContinuation
    if (!isObject(renderer)) continue
    if (Array.isArray(renderer.contents)) contents.push(...renderer.contents)
    const token = continuationToken(renderer)
    if (!continuation) continuation = token
  }
  if (!shelves.length) {
    // A watch page shows the queue as plain renderers without a shelf wrapper.
    for (const node of findNodes(payload, value =>
      isObject(value.musicResponsiveListItemRenderer) || isObject(value.playlistVideoRenderer))) {
      contents.push(node)
    }
    if (!continuation) continuation = continuationToken(payload)
  }
  return { contents, continuation }
}

function continuationToken(payload: unknown): string | null {
  const items = findNodes(payload, node => isObject(node.continuationItemRenderer))
  for (const item of items) {
    const renderer = item.continuationItemRenderer
    if (!isObject(renderer)) continue
    const endpoint = renderer.continuationEndpoint
    if (isObject(endpoint) && isObject(endpoint.continuationCommand) &&
        typeof endpoint.continuationCommand.token === 'string' && endpoint.continuationCommand.token) {
      return endpoint.continuationCommand.token
    }
  }
  const continuations = findNodes(payload, node => Array.isArray(node.continuations))
  for (const node of continuations) {
    const first = Array.isArray(node.continuations) ? node.continuations[0] : null
    if (isObject(first) && isObject(first.nextContinuationData) &&
        typeof first.nextContinuationData.continuation === 'string' && first.nextContinuationData.continuation) {
      return first.nextContinuationData.continuation
    }
  }
  return null
}

function playlistName(payload: unknown): string | null {
  const headers = findNodes(payload, node =>
    isObject(node.musicDetailHeaderRenderer) || isObject(node.musicEditablePlaylistDetailHeaderRenderer))
  for (const header of headers) {
    const renderer = isObject(header.musicDetailHeaderRenderer)
      ? header.musicDetailHeaderRenderer
      : header.musicEditablePlaylistDetailHeaderRenderer
    if (!isObject(renderer)) continue
    const name = cleanText(textOf(renderer.title))
    if (name) return name.slice(0, 300)
  }
  const microformats = findNodes(payload, node => isObject(node.microformatDataRenderer))
  for (const microformat of microformats) {
    if (!isObject(microformat.microformatDataRenderer)) continue
    const name = cleanText(textOf(microformat.microformatDataRenderer.title))
    if (name) return name.slice(0, 300)
  }
  return null
}

export function parseYtMusicPlaylist(payload: unknown): YtMusicPlaylistPage {
  const { contents, continuation } = shelfContents(payload)
  const tracks: PipelineTrackInput[] = []
  for (const item of contents) {
    const track = parseYtMusicItem(item)
    if (track) tracks.push(track)
  }
  return { name: playlistName(payload), tracks, continuation }
}

/** Continuation responses only carry the next slice of rows. */
export function parseYtMusicContinuation(payload: unknown): YtMusicPlaylistPage {
  const { contents, continuation } = shelfContents(payload)
  const tracks: PipelineTrackInput[] = []
  for (const item of contents) {
    const track = parseYtMusicItem(item)
    if (track) tracks.push(track)
  }
  return { name: null, tracks, continuation }
}

function extractJsonAfter(source: string, marker: string, from = 0): { value: unknown; end: number } | null {
  const start = source.indexOf(marker, from)
  if (start < 0) return null
  const open = source.indexOf('{', start + marker.length)
  if (open < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = open; index < source.length; index++) {
    const character = source[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth++
    else if (character === '}') {
      depth--
      if (depth === 0) {
        try {
          return { value: JSON.parse(source.slice(open, index + 1)), end: index + 1 }
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Reads the page config the web client uses for its own API calls. */
export function parseYtMusicConfig(html: string): YtMusicClientConfig {
  let apiKey: string | null = null
  let clientVersion: string | null = null
  let context: unknown = null
  let cursor = 0
  for (let guard = 0; guard < 20; guard++) {
    const extracted = extractJsonAfter(html, 'ytcfg.set(', cursor)
    if (!extracted) break
    cursor = extracted.end
    if (!isObject(extracted.value)) continue
    const config = extracted.value
    if (typeof config.INNERTUBE_API_KEY === 'string') apiKey = config.INNERTUBE_API_KEY
    if (typeof config.INNERTUBE_CLIENT_VERSION === 'string') clientVersion = config.INNERTUBE_CLIENT_VERSION
    if (isObject(config.INNERTUBE_CONTEXT)) context = config.INNERTUBE_CONTEXT
  }
  return { apiKey, context, clientVersion }
}

export function parseYtMusicPage(html: string): { initialData: unknown; config: YtMusicClientConfig } {
  let initialData: unknown = null
  for (const marker of ['var ytInitialData =', 'window["ytInitialData"] =', 'ytInitialData =', 'ytInitialData']) {
    const initial = extractJsonAfter(html, marker)
    if (initial) {
      initialData = initial.value
      break
    }
  }
  return { initialData, config: parseYtMusicConfig(html) }
}

export function buildYtMusicContinuationRequest(
  config: YtMusicClientConfig,
  token: string,
): { url: string; headers: Record<string, string>; body: string } {
  const url = config.apiKey
    ? `${ytMusicContinuationUrl}?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`
    : `${ytMusicContinuationUrl}?prettyPrint=false`
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': config.clientVersion ?? '1.20250101.00.00',
    },
    body: JSON.stringify({ context: config.context, continuation: token }),
  }
}

export const ytMusicBrowseUrl = 'https://music.youtube.com/youtubei/v1/browse'

/**
 * YouTube stopped embedding `ytInitialData` into the playlist HTML, so the
 * first page has to come from the same InnerTube call the web client makes.
 * `VL` in front of the list id is what marks it as a playlist browse.
 */
export function buildYtMusicBrowseRequest(
  config: YtMusicClientConfig,
  listId: string,
): { url: string; headers: Record<string, string>; body: string } {
  const url = config.apiKey
    ? `${ytMusicBrowseUrl}?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`
    : `${ytMusicBrowseUrl}?prettyPrint=false`
  return {
    url,
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': config.clientVersion ?? '1.20250101.00.00',
    },
    body: JSON.stringify({ context: config.context, browseId: `VL${listId}` }),
  }
}

/** Accepts `music.youtube.com/playlist?list=…` and watch links that carry a list. */
export function parseYtMusicPlaylistId(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'music.youtube.com' && parsed.hostname !== 'www.youtube.com' &&
        parsed.hostname !== 'youtube.com' && parsed.hostname !== 'm.youtube.com') {
      return null
    }
    const list = parsed.searchParams.get('list')
    return list && /^[A-Za-z0-9_-]{10,}$/.test(list) ? list : null
  } catch {
    return null
  }
}

export function mergeYtMusicTracks(
  existing: readonly PipelineTrackInput[],
  next: readonly PipelineTrackInput[],
): PipelineTrackInput[] {
  const seen = new Set(existing.map(track => track.providerId).filter((id): id is string => !!id))
  const merged = [...existing]
  for (const track of next) {
    if (track.providerId && seen.has(track.providerId)) continue
    if (track.providerId) seen.add(track.providerId)
    merged.push(track)
    if (merged.length >= maxTracks) break
  }
  return merged
}

export { maxPages, maxTracks }
