import { session } from 'electron'
import { WebContentsView } from 'electron'
import type { BrowserWindow, Session } from 'electron'
import type { ProviderPlaylist, WebSourceBounds, WebSourceProvider, WebSourceState } from '../shared/pipeline'
import {
  buildYtMusicContinuationRequest, maxPages, maxTracks, mergeYtMusicTracks,
  parseYtMusicContinuation, parseYtMusicPage, parseYtMusicPlaylist, parseYtMusicPlaylistId,
} from '../metadata/providers/ytmusic'

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

const providerHome: Record<WebSourceProvider, string> = {
  ytmusic: 'https://music.youtube.com/',
}

const allowedHosts = ['music.youtube.com', 'youtube.com', 'google.com', 'gstatic.com']

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
    if (!(provider in providerHome)) throw new Error('Неизвестный веб-источник')
    if (this.view && this.provider === provider && this.window === parent) {
      if (!this.view.webContents.isDestroyed()) this.view.webContents.loadURL(providerHome[provider]).catch(() => {})
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
    void view.webContents.loadURL(providerHome[provider]).catch(() => {})
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
    if (this.provider !== 'ytmusic') throw new Error('Этот веб-источник пока не поддерживается')
    const currentUrl = this.view.webContents.getURL()
    const listId = parseYtMusicPlaylistId(currentUrl)
    if (!listId) throw new Error('Откройте плейлист YT Music в окне сервиса и повторите импорт')
    return await this.importYtMusicPlaylist(listId, currentUrl)
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

  dispose(): void {
    this.close()
  }
}
