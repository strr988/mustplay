import { dialog, ipcMain, shell } from 'electron'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { channels, playerOrigin, yandexLyricsFormats, yandexQualities } from '../shared/contracts'
import type { YandexLyricsFormat, YandexQuality, YandexSearchResult, YandexSettings, YandexTrack } from '../shared/contracts'
import { fullTitle, YandexApi, YandexError } from './yandex-api'
import { YandexCoverProxy } from './yandex-cover'
import { YandexDownloads } from './yandex-downloads'
import { defaultDownloadFolder, downloadFolderStatus, requireDownloadFolder } from './download-folder'
import { readYandexToken, writeYandexToken, yandexTokenPage } from './yandex-token'
import type { Library } from './library'

const trackIdPattern = /^\d{1,20}$/
const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const maxRecentTracks = 500

function plainText(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Error('Invalid text argument')
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) throw new Error('Invalid text argument')
  for (let index = 0; index < trimmed.length; index++) {
    const code = trimmed.charCodeAt(index)
    if (code < 32 || code === 127) throw new Error('Invalid text argument')
  }
  return trimmed
}

function trackId(value: unknown): string {
  if (typeof value !== 'string' || !trackIdPattern.test(value)) throw new Error('Invalid track ID')
  return value
}

export function registerYandex(
  library: Library,
  getMain: () => BrowserWindow | null,
  mainSender: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const coverProxy = new YandexCoverProxy((uri, signal) => new YandexApi('').cover(uri, '400x400', signal))
  const recent = new Map<string, YandexTrack>()
  const downloads = new YandexDownloads(list => getMain()?.webContents.send(channels.yandexDownloads, list))

  function readToken(): string | null {
    return readYandexToken(library)
  }

  function writeToken(token: string): void {
    writeYandexToken(library, token)
  }

  async function getSettings(): Promise<YandexSettings> {
    return {
      ...library.getYandexSettings(), hasToken: !!readToken(),
      ...await downloadFolderStatus(library.getYandexFolder()),
    }
  }

  function requireToken(): string {
    const token = readToken()
    if (!token) throw new Error('Сначала укажите токен Яндекс Музыки')
    return token
  }

  function remember(tracks: YandexTrack[]): void {
    for (const track of tracks) {
      recent.set(track.id, track)
      if (recent.size > maxRecentTracks) recent.delete(recent.keys().next().value!)
    }
  }

  ipcMain.handle(channels.getYandexSettings, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length) throw new Error('Unexpected Yandex settings arguments')
    return getSettings()
  })
  ipcMain.handle(channels.setYandexToken, async (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length !== 1) throw new Error('Invalid Yandex token arguments')
    if (args[0] === '') {
      writeToken('')
      return getSettings()
    }
    const token = plainText(args[0], 512)
    try {
      await new YandexApi(token).verify()
    } catch (error) {
      if (error instanceof YandexError && (error.kind === 'unauthorized' || error.kind === 'invalid')) {
        throw new Error('Токен не принят Яндекс Музыкой. Проверьте его и повторите.')
      }
    }
    writeToken(token)
    return getSettings()
  })
  ipcMain.handle(channels.setYandexQuality, (event, ...args: unknown[]) => {
    mainSender(event)
    const [quality] = args
    if (args.length !== 1 || !yandexQualities.includes(quality as YandexQuality)) throw new Error('Invalid Yandex quality')
    library.setYandexQuality(quality as YandexQuality)
  })
  ipcMain.handle(channels.setYandexLyrics, (event, ...args: unknown[]) => {
    mainSender(event)
    const [format] = args
    if (args.length !== 1 || !yandexLyricsFormats.includes(format as YandexLyricsFormat)) throw new Error('Invalid Yandex lyrics format')
    library.setYandexLyrics(format as YandexLyricsFormat)
  })
  ipcMain.handle(channels.setYandexEmbedCover, (event, ...args: unknown[]) => {
    mainSender(event)
    const [enabled] = args
    if (args.length !== 1 || typeof enabled !== 'boolean') throw new Error('Invalid Yandex cover setting')
    library.setYandexEmbedCover(enabled)
  })
  ipcMain.handle(channels.chooseYandexFolder, async (event, ...args: unknown[]) => {
    const owner = mainSender(event)
    if (args.length) throw new Error('Unexpected Yandex folder arguments')
    const selection = await dialog.showOpenDialog(owner, {
      title: 'Папка для загрузок Яндекс Музыки', defaultPath: library.getYandexFolder() || defaultDownloadFolder(), properties: ['openDirectory', 'createDirectory'],
    })
    if (!selection.canceled && selection.filePaths[0]) {
      await requireDownloadFolder(selection.filePaths[0])
      library.setYandexFolder(selection.filePaths[0])
    }
    return getSettings()
  })
  ipcMain.handle(channels.resetYandexFolder, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length) throw new Error('Unexpected Yandex folder arguments')
    library.setYandexFolder(null)
    return getSettings()
  })
  ipcMain.handle(channels.openYandexTokenPage, async (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length) throw new Error('Unexpected Yandex token page arguments')
    await shell.openExternal(yandexTokenPage)
  })
  ipcMain.handle(channels.yandexSearch, async (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length !== 2) throw new Error('Invalid Yandex search arguments')
    const query = plainText(args[0], 200)
    const page = args[1]
    if (typeof page !== 'number' || !Number.isInteger(page) || page < 0 || page > 1000) throw new Error('Invalid Yandex search page')
    const api = new YandexApi(requireToken())
    const { tracks, total, perPage } = await api.search(query, page)
    const result: YandexTrack[] = tracks.map(track => {
      coverProxy.register(track.id, track.coverUri)
      return {
        id: track.id,
        title: fullTitle(track),
        artist: track.artists.map(artist => artist.name).join(', ') || null,
        album: track.album ? fullTitle(track.album) : null,
        durationSeconds: track.durationMs != null ? track.durationMs / 1000 : null,
        coverUrl: track.coverUri ? `${playerOrigin}/yandex-cover/${track.id}` : null,
        available: track.available,
      }
    })
    remember(result)
    const search: YandexSearchResult = { tracks: result, total, page, perPage }
    return search
  })
  ipcMain.handle(channels.yandexDownload, async (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length !== 1) throw new Error('Invalid Yandex download arguments')
    const id = trackId(args[0])
    const token = requireToken()
    const folder = await requireDownloadFolder(library.getYandexFolder())
    const settings = library.getYandexSettings()
    const meta = recent.get(id)
    return downloads.enqueue(id, {
      token, quality: settings.quality, lyrics: settings.lyrics, embedCover: settings.embedCover, folder,
    }, { title: meta?.title ?? '', artist: meta?.artist ?? null })
  })
  ipcMain.handle(channels.yandexCancelDownload, (event, ...args: unknown[]) => {
    mainSender(event)
    const [id] = args
    if (args.length !== 1 || typeof id !== 'string' || !jobIdPattern.test(id)) throw new Error('Invalid Yandex download ID')
    downloads.cancel(id)
  })
  ipcMain.handle(channels.getYandexDownloads, (event, ...args: unknown[]) => {
    mainSender(event)
    if (args.length) throw new Error('Unexpected Yandex downloads arguments')
    return downloads.list()
  })

  return {
    coverProxy,
    dispose: () => downloads.dispose(),
  }
}