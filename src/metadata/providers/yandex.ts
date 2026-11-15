import type { PipelineTrackInput, ProviderPlaylist } from '../../shared/pipeline'

/**
 * Yandex Music has no public playlist API, but its own web UI reads a JSON
 * endpoint with the same session cookies. We use exactly that endpoint, so the
 * user logs in inside the app and never shares a password with us.
 */

export interface YandexPlaylistRef {
  owner: string
  kind: string
}

export function parseYandexPlaylistUrl(value: string): YandexPlaylistRef | null {
  try {
    const url = new URL(value)
    if (!/(^|\.)music\.yandex\.(ru|com|by|kz|uz)$/i.test(url.hostname)) return null
    const match = /^\/(?:users\/([^/]+))?\/playlists\/([0-9]+)/i.exec(url.pathname)
    if (!match) return null
    const owner = match[1] ? decodeURIComponent(match[1]) : ''
    if (!owner) return null
    return { owner, kind: match[2]! }
  } catch {
    return null
  }
}

export function yandexPlaylistEndpoint(ref: YandexPlaylistRef): string {
  return `https://music.yandex.ru/handlers/playlist.jsx?owner=${encodeURIComponent(ref.owner)}&kinds=${encodeURIComponent(ref.kind)}`
}

interface JsonObject { [key: string]: unknown }

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function list(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function names(value: unknown): string[] {
  return list(value).map(item => text(item.name)).filter((name): name is string => !!name)
}

/**
 * Tolerant parser for the playlist handler payload. Yandex omits fields for
 * unavailable tracks and returns `null` entries, so everything is optional.
 */
export function parseYandexPlaylist(payload: unknown): ProviderPlaylist {
  const root = isObject(payload) ? payload : {}
  const playlist = isObject(root.playlist) ? root.playlist : root
  const title = text(playlist.title) ?? 'Плейлист Яндекс Музыки'
  const tracks: PipelineTrackInput[] = []
  for (const entry of list(playlist.tracks)) {
    const trackTitle = text(entry.title)
    if (!trackTitle) continue
    const album = list(entry.albums)[0]
    const isrc = text(entry.isrc)?.toUpperCase() ?? null
    const durationMs = typeof entry.durationMs === 'number' ? entry.durationMs : null
    tracks.push({
      title: trackTitle.slice(0, 300),
      artist: names(entry.artists).join(', ') || null,
      album: album ? text(album.title) : null,
      durationSeconds: durationMs && durationMs > 0 ? Math.round(durationMs / 1000) : null,
      isrc: isrc && /^[A-Z0-9]{12}$/.test(isrc) ? isrc : null,
      providerId: typeof entry.id === 'number' || typeof entry.id === 'string' ? String(entry.id) : null,
      albumProviderId: album && (typeof album.id === 'number' || typeof album.id === 'string')
        ? String(album.id) : null,
    })
  }
  return {
    name: title,
    tracks,
    note: `Список прочитан из вашей сессии Яндекс Музыки: ${tracks.length} треков.`,
  }
}
