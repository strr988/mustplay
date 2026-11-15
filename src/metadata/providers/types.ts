import type { PipelineProvider, ProviderPlaylist } from '../../shared/pipeline'

export interface MetadataProvider {
  id: PipelineProvider
  requiresAuth: boolean
  providesIsrc: boolean
  fetchPlaylist(id: string): Promise<ProviderPlaylist>
}

export class ProviderError extends Error {
  constructor(readonly provider: PipelineProvider, message: string) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface PlaylistRef {
  provider: PipelineProvider
  id: string
  url: string
}

const patterns: ReadonlyArray<{ provider: PipelineProvider; pattern: RegExp; idIndex: number }> = [
  { provider: 'deezer', pattern: /(?:^|\/\/)(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/i, idIndex: 1 },
  { provider: 'spotify', pattern: /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/|spotify:playlist:)([A-Za-z0-9]+)/i, idIndex: 1 },
  { provider: 'apple', pattern: /music\.apple\.com\/[a-z]{2}\/playlist\/[^/]+\/([a-z0-9._-]+)/i, idIndex: 1 },
  { provider: 'yandex', pattern: /music\.yandex\.[a-z]+\/users\/([^/]+)\/playlists\/(\d+)/i, idIndex: 2 },
  { provider: 'vk', pattern: /(?:vk\.com|vk\.ru)\/music\/playlist\/(-?\d+_\d+)/i, idIndex: 1 },
  { provider: 'soundcloud', pattern: /soundcloud\.com\/[^/]+\/sets\/([A-Za-z0-9-]+)/i, idIndex: 1 },
  { provider: 'ytmusic', pattern: /music\.youtube\.com\/playlist\?(?:[^#]*&)?list=([A-Za-z0-9_-]+)/i, idIndex: 1 },
]

export function parsePlaylistUrl(input: string): PlaylistRef | null {
  const url = input.trim()
  if (!url || url.length > 2_048) return null
  for (const { provider, pattern, idIndex } of patterns) {
    const match = pattern.exec(url)
    if (!match) continue
    const id = maybeDecode(match[idIndex] ?? '')
    if (!id) continue
    return { provider, id, url }
  }
  return null
}

function maybeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export const stubProviders: ReadonlySet<PipelineProvider> = new Set(['apple', 'yandex', 'vk', 'soundcloud'])
