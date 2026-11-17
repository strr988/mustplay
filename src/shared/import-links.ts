import type { PipelineProvider } from './pipeline'
import { pipelineProviderLabels } from './pipeline'

/**
 * One description of "what can be imported" for both the interface and Main.
 *
 * The rule this file exists for: a link is enabled in the interface only when
 * the pipeline can finish it. Anything else must be explained, never attempted.
 */

export type LinkKind = 'playlist' | 'album' | 'set' | 'track' | 'liked' | 'artist' | 'profile'

export const linkKindLabels: Record<LinkKind, string> = {
  playlist: 'плейлист',
  album: 'альбом',
  set: 'сет',
  track: 'трек',
  liked: 'любимые треки',
  artist: 'артист',
  profile: 'профиль',
}

export interface ImportSource {
  provider: PipelineProvider
  /** Canonical hosts. Matching is exact or a dot-suffix, so `m.soundcloud.com` works. */
  hosts: readonly string[]
  /** Sharing redirectors that Main resolves before parsing. */
  shortHosts?: readonly string[]
  /** Link kinds the pipeline imports from a bare URL today. */
  kinds: readonly LinkKind[]
}

export const importSources: readonly ImportSource[] = [
  {
    provider: 'deezer',
    hosts: ['deezer.com'],
    shortHosts: ['link.deezer.com', 'deezer.page.link'],
    kinds: ['playlist'],
  },
  {
    provider: 'spotify',
    hosts: ['spotify.com'],
    shortHosts: ['spotify.link', 'spoti.fi'],
    kinds: ['playlist'],
  },
  // Playlist reading through api.music.yandex.net is not connected yet.
  { provider: 'yandex', hosts: ['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.uz'], kinds: [] },
  {
    provider: 'soundcloud',
    hosts: ['soundcloud.com'],
    shortHosts: ['on.soundcloud.com', 'soundcloud.app.goo.gl'],
    kinds: ['set'],
  },
  // YouTube Music playlists are read inside a logged-in web session only.
  { provider: 'ytmusic', hosts: ['youtube.com'], shortHosts: ['youtu.be'], kinds: [] },
  { provider: 'vk', hosts: ['vk.com', 'vk.ru'], shortHosts: ['vk.cc'], kinds: [] },
  { provider: 'apple', hosts: ['music.apple.com'], kinds: [] },
]

export interface LinkInfo {
  provider: PipelineProvider
  kind: LinkKind
  supported: boolean
  /** Sharing redirectors cannot be parsed directly; Main resolves them first. */
  short?: boolean
}

export function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

function detectKind(path: string, search: string): LinkKind | null {
  // Segment matching, not substring: /collection/tracks is a saved-tracks list,
  // not a single track, and /playlists must not look like /playlist/123.
  const segments = path.split('/').filter(Boolean)
  if (segments.includes('set') || segments.includes('sets')) return 'set'
  if (segments.includes('playlist') || segments.includes('playlists')) return 'playlist'
  if (segments.includes('album') || segments.includes('albums')) return 'album'
  if (segments.includes('track')) return 'track'
  if (segments.includes('artist')) return 'artist'
  if (segments.includes('likes') || segments.includes('liked')) return 'liked'
  if (search.includes('list=')) return 'playlist'
  if (search.includes('v=')) return 'track'
  return null
}

const spotifyUri = /^spotify:(playlist|album|track|artist):([A-Za-z0-9]+)$/i

function sourceForHost(host: string): ImportSource | null {
  return importSources.find(source => source.hosts.some(domain => hostMatches(host, domain))) ?? null
}

function shortSourceForHost(host: string): ImportSource | null {
  return importSources.find(source => source.shortHosts?.some(domain => hostMatches(host, domain))) ?? null
}

function supportedKind(source: ImportSource, kind: LinkKind): boolean {
  return source.kinds.includes(kind)
}

/**
 * Recognises the service from the link itself, so the interface can show the
 * right hint before anything is requested. Main re-checks the same table.
 */
export function detectImportLink(raw: string): LinkInfo | null {
  const text = raw.trim()
  if (!text || /\s/.test(text)) return null

  const uri = spotifyUri.exec(text)
  if (uri) {
    const kind = uri[1]!.toLowerCase() as LinkKind
    const source = importSources.find(item => item.provider === 'spotify')!
    return { provider: 'spotify', kind, supported: supportedKind(source, kind) }
  }

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.toLowerCase()
  const search = url.search.toLowerCase()
  const kind = detectKind(path, search)

  const short = shortSourceForHost(host)
  if (short) {
    // The full address is only known after following the redirect, so the
    // interface enables the button when the service itself can be imported.
    return {
      provider: short.provider,
      kind: kind ?? 'profile',
      supported: short.kinds.length > 0,
      short: true,
    }
  }

  const source = sourceForHost(host)
  if (!source) return null

  // A SoundCloud track is /artist/slug; anything without a keyword is a profile.
  if (source.provider === 'soundcloud' && !kind && path.split('/').filter(Boolean).length >= 2) {
    return { provider: 'soundcloud', kind: 'track', supported: supportedKind(source, 'track') }
  }

  const resolved = kind ?? 'profile'
  return { provider: source.provider, kind: resolved, supported: supportedKind(source, resolved) }
}

export interface SupportedLink {
  provider: PipelineProvider
  kind: LinkKind
  /** A real, valid address used by tests so the hint cannot drift from the parser. */
  url: string
  /** Short shape shown to the user. */
  example: string
}

/** Exactly the links the pipeline resolves today, in display order. */
export const supportedLinks: readonly SupportedLink[] = [
  {
    provider: 'deezer',
    kind: 'playlist',
    url: 'https://www.deezer.com/playlist/1234567',
    example: 'deezer.com/playlist/… или link.deezer.com/…',
  },
  {
    provider: 'spotify',
    kind: 'playlist',
    url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M',
    example: 'open.spotify.com/playlist/… или spoti.fi/…',
  },
  {
    provider: 'soundcloud',
    kind: 'set',
    url: 'https://soundcloud.com/forss/sets/soulhack',
    example: 'soundcloud.com/artist/sets/… или on.soundcloud.com/…',
  },
]

/** Shared wording for the reason a recognised link cannot be imported. */
export function blockedLinkReason(info: LinkInfo, yandexSaved = false): string {
  if (info.provider === 'yandex') {
    return yandexSaved
      ? 'Токен сохранён, но чтение плейлистов через API ещё не подключено.'
      : 'Чтение плейлистов Яндекса ещё не подключено. Токен можно сохранить заранее — в настройках.'
  }
  if (info.provider === 'vk') return 'Импорт из ВК пока недоступен: нет резолвера прямых ссылок на аудио.'
  if (info.provider === 'ytmusic') {
    return 'Ссылку YouTube нельзя импортировать напрямую. Откройте YouTube Music в плитке ниже и войдите в аккаунт.'
  }
  if (info.provider === 'apple') return 'Apple Music не поддерживается.'
  if (info.kind === 'artist' || info.kind === 'profile') {
    return 'Это страница артиста или профиль. Нужна ссылка на плейлист.'
  }
  return `Сейчас импортируются только плейлисты и сеты. Ссылка на ${linkKindLabels[info.kind]} не поддерживается.`
}

export function linkNote(info: LinkInfo, yandexSaved: boolean): string {
  if (info.short && info.supported) return 'Короткая ссылка — развернём её при импорте.'
  if (info.short && !info.supported) return blockedLinkReason(info, yandexSaved)
  if (info.provider === 'yandex') return blockedLinkReason(info, yandexSaved)
  if (!info.supported) return blockedLinkReason(info, yandexSaved)
  switch (info.provider) {
    case 'soundcloud': return 'Публичный сет читается без входа; закрытые подборки — через аккаунт.'
    case 'spotify': return 'Публичная страница читается без входа; Web API не обязателен.'
    case 'deezer': return 'Читается через публичный API без входа.'
    default: return ''
  }
}

export function importActionLabel(info: LinkInfo | null): string {
  if (!info || info.short) return 'Импортировать'
  if (info.kind === 'album') return 'Импортировать альбом'
  if (info.kind === 'set') return 'Импортировать сет'
  if (info.kind === 'track') return 'Импортировать трек'
  return 'Импортировать плейлист'
}

export function linkSummary(info: LinkInfo): string {
  return `${pipelineProviderLabels[info.provider]} · ${info.short ? 'короткая ссылка' : linkKindLabels[info.kind]}`
}
