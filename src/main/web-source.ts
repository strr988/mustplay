import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { session } from 'electron'
import { WebContentsView } from 'electron'
import type { BrowserWindow, Session } from 'electron'
import type { ProviderPlaylist, WebSourceBounds, WebSourceProvider, WebSourceState } from '../shared/pipeline'
import { pipelineProviderLabels } from '../shared/pipeline'
import {
  buildYtMusicContinuationRequest, maxPages, maxTracks, mergeYtMusicTracks,
  parseYtMusicContinuation, parseYtMusicPage, parseYtMusicPlaylist, parseYtMusicPlaylistId,
} from '../metadata/providers/ytmusic'
import { parseYandexPlaylist, parseYandexPlaylistUrl, yandexPlaylistEndpoint } from '../metadata/providers/yandex'
import { parsePlaylistOutput, playlistArguments } from '../audio/ytdlp'
import { runProcess } from '../audio/process'

/**
 * Web sources are read inside the user's own browser session: the app opens a
 * real page in an isolated `persist:` partition, the user logs in normally and
 * then points at a playlist. The app never sees credentials, only the session
 * cookies Chromium already manages.
 */
export const webSourcePartition = 'persist:mustplay-sources'

export interface WebSourceImport {
  provider: WebSourceProvider
  url: string
  playlist: ProviderPlaylist
}

interface ProviderConfig {
  home: string
  hosts: string[]
}

const providerConfig: Record<WebSourceProvider, ProviderConfig> = {
  ytmusic: {
    home: 'https://music.youtube.com/',
    hosts: ['music.youtube.com', 'youtube.com', 'gstatic.com', 'googlevideo.com'],
  },
  yandex: {
    home: 'https://music.yandex.ru/',
    hosts: ['yandex.ru', 'yandex.com', 'yandex.net', 'yastatic.net'],
  },
  vk: {
    home: 'https://vk.com/music',
    hosts: ['vk.com', 'vk.ru', 'userapi.com', 'vk-cdn.net', 'mycdn.me'],
  },
  soundcloud: {
    home: 'https://soundcloud.com/',
    hosts: ['soundcloud.com', 'sndcdn.com', 'soundcloud.cloud'],
  },
}

// Every provider shares one persisted session, so navigation is checked against
// the union of their hosts; non-HTTPS and unknown hosts are still blocked.
const allowedHosts = [...new Set([
  'google.com',
  ...Object.values(providerConfig).flatMap(config => config.hosts),
])]

function isAllowedUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return allowedHosts.some(allowed => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

let ytDlpPath: (() => string | null) | null = null

/** The pipeline owns the tool manager, so it supplies the binary once it exists. */
export function setWebSourceYtDlpResolver(resolver: () => string | null): void {
  ytDlpPath = resolver
}

/**
 * yt-dlp cannot read Chromium's cookie database, so the session cookies are
 * written to a short-lived Netscape cookie file for Sources that need a login.
 */
async function exportCookies(sources: Session): Promise<{ dir: string; path: string } | null> {
  const cookies = await sources.cookies.get({})
  if (!cookies.length) return null
  const dir = await mkdtemp(join(tmpdir(), 'mustplay-cookies-'))
  const path = join(dir, 'cookies.txt')
  const lines = ['# Netscape HTTP Cookie File', '']
  for (const cookie of cookies) {
    if (!cookie.domain || !cookie.name) continue
    if (cookie.httpOnly) {
      // yt-dlp expects the #HttpOnly_ prefix for cookies the page cannot see.
      lines.push(`#HttpOnly_${cookie.domain}\t${cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE'}\t${cookie.path || '/'}\t${cookie.secure ? 'TRUE' : 'FALSE'}\t${cookie.expirationDate ? Math.round(cookie.expirationDate) : 0}\t${cookie.name}\t${cookie.value}`)
      continue
    }
    lines.push([cookie.domain, cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path || '/',
      cookie.secure ? 'TRUE' : 'FALSE', String(cookie.expirationDate ? Math.round(cookie.expirationDate) : 0),
      cookie.name, cookie.value].join('\t'))
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return { dir, path }
}

export class WebSourceManager {
  private view: WebContentsView | null = null
  private provider: WebSourceProvider | null = null
  private window: BrowserWindow | null = null
  private bounds: WebSourceBounds | null = null
  private sessionReady = false
  private readonly layout = () => this.applyLayout()

  private sourcesSession(): Session {
    const sources = session.fromPartition(webSourcePartition)
    if (!this.sessionReady) {
      this.sessionReady = true
      sources.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      sources.setPermissionCheckHandler(() => false)
      sources.setSpellCheckerEnabled(false)
      sources.on('will-download', event => event.preventDefault())
    }
    return sources
  }

  state(): WebSourceState {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return { open: false, provider: null, url: null, title: null }
    }
    return {
      open: true,
      provider: this.provider,
      url: this.view.webContents.getURL(),
      title: this.view.webContents.getTitle(),
    }
  }

  open(provider: WebSourceProvider, parent: BrowserWindow): WebSourceState {
    const config = providerConfig[provider]
    if (!config) throw new Error('Неизвестный веб-источник')
    if (this.view && this.provider === provider && this.window === parent) {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.loadURL(config.home).catch(() => {})
      return this.state()
    }
    this.close()
    const sources = this.sourcesSession()
    const view = new WebContentsView({
      webPreferences: {
        session: sources,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    })
    view.setBackgroundColor('#15131a')
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => {
      if (!isAllowedUrl(event.url)) event.preventDefault()
    })
    view.webContents.on('will-attach-webview', event => event.preventDefault())
    view.webContents.on('render-process-gone', () => this.close())
    this.view = view
    this.provider = provider
    this.window = parent
    parent.contentView.addChildView(view)
    parent.on('resize', this.layout)
    void view.webContents.loadURL(config.home).catch(() => {})
    return this.state()
  }

  /** The renderer reports the rectangle of its placeholder, in CSS pixels. */
  setBounds(next: WebSourceBounds): void {
    for (const value of [next.x, next.y, next.width, next.height]) {
      if (!Number.isFinite(value) || value < 0 || value > 20_000) throw new Error('Некорректные границы окна сервиса')
    }
    const factor = this.window && !this.window.webContents.isDestroyed()
      ? this.window.webContents.getZoomFactor()
      : 1
    this.bounds = {
      x: Math.round(next.x * factor),
      y: Math.round(next.y * factor),
      width: Math.round(next.width * factor),
      height: Math.round(next.height * factor),
    }
    this.applyLayout()
  }

  private applyLayout(): void {
    const parent = this.window
    const view = this.view
    if (!parent || parent.isDestroyed() || !view || view.webContents.isDestroyed()) return
    const bounds = this.bounds
    if (!bounds) return
    const content = parent.getContentBounds()
    view.setBounds({
      x: Math.min(bounds.x, Math.max(0, content.width - 1)),
      y: Math.min(bounds.y, Math.max(0, content.height - 1)),
      width: Math.max(0, Math.min(bounds.width, content.width - bounds.x)),
      height: Math.max(0, Math.min(bounds.height, content.height - bounds.y)),
    })
  }

  close(): void {
    const parent = this.window
    const view = this.view
    if (parent && !parent.isDestroyed()) parent.off('resize', this.layout)
    this.view = null
    this.provider = null
    this.window = null
    this.bounds = null
    if (!view) return
    if (parent && !parent.isDestroyed()) parent.contentView.removeChildView(view)
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    } catch {
      // The view may already be gone during shutdown.
    }
  }

  async clearData(): Promise<void> {
    this.close()
    const sources = this.sourcesSession()
    await sources.clearStorageData()
    await sources.clearCache()
  }

  async importPlaylist(): Promise<WebSourceImport> {
    if (!this.view || this.view.webContents.isDestroyed() || !this.provider) {
      throw new Error('Сначала откройте окно сервиса')
    }
    const provider = this.provider
    const currentUrl = this.view.webContents.getURL()
    const sources = this.sourcesSession()
    if (provider === 'ytmusic') {
      const listId = parseYtMusicPlaylistId(currentUrl)
      if (!listId) throw new Error('Откройте плейлист YT Music в окне сервиса и повторите импорт')
      return await this.importYtMusicPlaylist(listId, currentUrl)
    }
    if (provider === 'yandex') return await this.importYandexPlaylist(currentUrl, sources)
    return await this.importWithYtDlp(provider, currentUrl, sources)
  }

  private async importYtMusicPlaylist(listId: string, currentUrl: string): Promise<WebSourceImport> {
    const sources = this.sourcesSession()
    const pageUrl = `https://music.youtube.com/playlist?list=${encodeURIComponent(listId)}`
    const response = await sources.fetch(pageUrl, {
      headers: { 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
    })
    if (!response.ok) throw new Error(`YT Music ответил ${response.status}`)
    const { initialData, config } = parseYtMusicPage(await response.text())
    if (!initialData) throw new Error('Не удалось прочитать страницу плейлиста YT Music')

    const first = parseYtMusicPlaylist(initialData)
    let tracks = first.tracks
    let continuation = first.continuation
    const name = first.name ?? 'Плейлист YT Music'
    for (let page = 0; continuation && page < maxPages && tracks.length < maxTracks; page++) {
      const request = buildYtMusicContinuationRequest(config, continuation)
      const next = await sources.fetch(request.url, {
        method: 'POST', headers: request.headers, body: request.body,
      })
      if (!next.ok) break
      const slice = parseYtMusicContinuation(await next.json())
      tracks = mergeYtMusicTracks(tracks, slice.tracks)
      continuation = slice.continuation
    }
    if (!tracks.length) throw new Error('В плейлисте не нашлось треков')
    const truncated = tracks.length >= maxTracks || continuation !== null
    const note = truncated
      ? `Список прочитан из вашей сессии YT Music: ${tracks.length} треков, продолжение не загружено.`
      : `Список прочитан из вашей сессии YT Music: ${tracks.length} треков.`
    return { provider: 'ytmusic', url: currentUrl, playlist: { name, tracks, note } }
  }

  private async importYandexPlaylist(currentUrl: string, sources: Session): Promise<WebSourceImport> {
    const ref = parseYandexPlaylistUrl(currentUrl)
    if (!ref) throw new Error('Откройте плейлист Яндекс Музыки в окне сервиса и повторите импорт')
    const response = await sources.fetch(yandexPlaylistEndpoint(ref), {
      headers: { Accept: 'application/json', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8' },
    })
    if (!response.ok) throw new Error(`Яндекс Музыка ответила ${response.status}. Войдите в аккаунт и повторите.`)
    const playlist = parseYandexPlaylist(await response.json())
    if (!playlist.tracks.length) throw new Error('В плейлисте не нашлось треков')
    return { provider: 'yandex', url: currentUrl, playlist }
  }

  /**
   * SoundCloud and VK expose a page yt-dlp can read with the session cookies.
   * This also covers private playlists of the signed-in account.
   */
  private async importWithYtDlp(
    provider: WebSourceProvider,
    currentUrl: string,
    sources: Session,
  ): Promise<WebSourceImport> {
    const binary = ytDlpPath?.()
    if (!binary) throw new Error('Инструменты импорта ещё не установлены. Запустите импорт по ссылке, чтобы mustplay их поставил.')
    const cookies = await exportCookies(sources).catch(() => null)
    try {
      let stdout: string
      try {
        ({ stdout } = await runProcess(binary, playlistArguments(currentUrl, cookies?.path ?? null), {
          timeoutMs: 3 * 60_000,
        }))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Не удалось прочитать плейлист: ${reason}`)
      }
      const parsed = parsePlaylistOutput(stdout)
      if (!parsed || !parsed.tracks.length) throw new Error('В плейлисте не нашлось треков')
      return {
        provider,
        url: currentUrl,
        playlist: {
          name: parsed.name ?? `Плейлист ${pipelineProviderLabels[provider]}`,
          tracks: parsed.tracks,
          note: `Список прочитан из вашей сессии ${pipelineProviderLabels[provider]}: ${parsed.tracks.length} треков.`,
        },
      }
    } finally {
      if (cookies) await rm(cookies.dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  dispose(): void {
    this.close()
  }
}
