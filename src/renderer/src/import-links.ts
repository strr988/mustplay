import type { PipelineProvider } from '../../shared/pipeline'
import { pipelineProviderLabels } from '../../shared/pipeline'

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

export interface LinkInfo {
  provider: PipelineProvider
  kind: LinkKind
  supported: boolean
  /** Sharing shorteners cannot be resolved without opening them first. */
  short?: boolean
}

/**
 * Import paths the pipeline can actually finish from a bare link. The list is
 * deliberately narrower than "links we recognise": the interface must never
 * enable a button that the backend rejects with «Неизвестная ссылка».
 */
const supportedKinds: Partial<Record<PipelineProvider, readonly LinkKind[]>> = {
  deezer: ['playlist'],
  spotify: ['playlist'],
  soundcloud: ['set'],
}

function detectKind(path: string, search: string): LinkKind | null {
  if (path.includes('/sets/') || path.includes('/set/')) return 'set'
  if (path.includes('/playlist')) return 'playlist'
  if (path.includes('/album')) return 'album'
  if (path.includes('/track')) return 'track'
  if (path.includes('/artist')) return 'artist'
  if (path.includes('/likes') || path.includes('/liked')) return 'liked'
  if (search.includes('list=')) return 'playlist'
  if (search.includes('v=')) return 'track'
  return null
}

/**
 * Recognises the service from the link itself, so the interface can show the
 * right hint before anything is requested. The backend validates the URL again.
 */
export function readLink(raw: string): LinkInfo | null {
  const text = raw.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = url.pathname.toLowerCase()
  const search = url.search.toLowerCase()
  const at = (domain: string) => host === domain || host.endsWith(`.${domain}`)
  const kind = detectKind(path, search)
  const info = (provider: PipelineProvider): LinkInfo => {
    const resolved = kind ?? 'profile'
    return {
      provider,
      kind: resolved,
      supported: supportedKinds[provider]?.includes(resolved) ?? false,
    }
  }

  if (at('deezer.com')) return info('deezer')
  if (at('spotify.link')) return { provider: 'spotify', kind: kind ?? 'profile', supported: false, short: true }
  if (at('spotify.com')) return info('spotify')
  // Playlist reading through api.music.yandex.net is not connected yet.
  if (at('yandex.ru') || at('yandex.com')) return info('yandex')
  if (at('on.soundcloud.com')) return { provider: 'soundcloud', kind: 'profile', supported: false, short: true }
  if (at('soundcloud.com')) {
    // A SoundCloud track is /artist/slug; anything else without a keyword is a profile.
    if (!kind && path.split('/').filter(Boolean).length >= 2) {
      return { provider: 'soundcloud', kind: 'track', supported: false }
    }
    return info('soundcloud')
  }
  // YouTube Music playlists are read inside a logged-in web session only.
  if (at('youtu.be')) return { provider: 'ytmusic', kind: 'track', supported: false }
  if (at('youtube.com')) return info('ytmusic')
  if (at('vk.com') || at('vk.ru')) return info('vk')
  return null
}

export function linkNote(info: LinkInfo, yandexSaved: boolean): string {
  if (info.short) {
    return 'Короткая ссылка не читается. Откройте её в браузере и скопируйте полный адрес из строки.'
  }
  if (info.provider === 'yandex') {
    return yandexSaved
      ? 'Токен сохранён, но чтение плейлистов через API ещё не подключено.'
      : 'Чтение плейлистов Яндекса ещё не подключено. Токен можно сохранить заранее — в настройках.'
  }
  if (!info.supported) {
    if (info.provider === 'vk') return 'Импорт из ВК пока недоступен: нет резолвера прямых ссылок на аудио.'
    if (info.provider === 'ytmusic') {
      return 'Ссылку YouTube нельзя импортировать напрямую. Откройте YT Music в плитке ниже и войдите в аккаунт.'
    }
    if (info.kind === 'artist' || info.kind === 'profile') {
      return 'Это страница артиста или профиль. Нужна ссылка на плейлист.'
    }
    return `Сейчас импортируются только плейлисты и сеты. Ссылка на ${linkKindLabels[info.kind]} не поддерживается.`
  }
  switch (info.provider) {
    case 'soundcloud': return 'Публичный сет читается без входа; закрытые подборки — через аккаунт.'
    case 'spotify': return 'Публичная страница читается без входа; Web API не обязателен.'
    case 'deezer': return 'Читается через публичный API без входа.'
    default: return ''
  }
}

export function importActionLabel(info: LinkInfo | null): string {
  if (!info) return 'Импортировать'
  if (info.kind === 'album') return 'Импортировать альбом'
  if (info.kind === 'set') return 'Импортировать сет'
  if (info.kind === 'track') return 'Импортировать трек'
  return 'Импортировать плейлист'
}

export function linkSummary(info: LinkInfo): string {
  return `${pipelineProviderLabels[info.provider]} · ${info.short ? 'короткая ссылка' : linkKindLabels[info.kind]}`
}
