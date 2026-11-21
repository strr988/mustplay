import type { LinkInfo } from '../shared/import-links'
import { blockedLinkReason, detectImportLink } from '../shared/import-links'
import type { PlaylistRef } from '../metadata/providers/types'
import { parsePlaylistUrl } from '../metadata/providers/types'
import { pipelineProviderLabels } from '../shared/pipeline'
import type { ShortLinkTransport } from './short-links'
import { resolveShortLink, shortLinkFailureMessage } from './short-links'

/**
 * Turns whatever the user pasted into a playlist the pipeline can read.
 *
 * This lives outside PipelineService so the whole contract — recognition,
 * short-link resolution, parser parity and error wording — is covered by unit
 * tests without booting Electron or yt-dlp.
 */
export interface ImportTarget {
  ref: PlaylistRef
  info: LinkInfo
  /** True when a sharing redirector was followed. */
  short: boolean
}

export interface ResolveImportOptions {
  /** Chromium transport in Main; a scripted one in tests. */
  transport?: ShortLinkTransport
  /** The interface already knows whether a Yandex token is stored. */
  yandexSaved?: boolean
}

export async function resolveImportUrl(
  rawUrl: string,
  options: ResolveImportOptions = {},
): Promise<ImportTarget> {
  const yandexSaved = options.yandexSaved ?? false
  const declared = detectImportLink(rawUrl)
  if (!declared) {
    throw new Error('Ссылка не распознана: по ссылке импортируются плейлисты Deezer и Spotify, а также сеты SoundCloud')
  }
  if (!declared.supported) throw new Error(blockedLinkReason(declared, yandexSaved))

  let url = rawUrl.trim()
  let info = declared
  if (declared.short) {
    try {
      url = await resolveShortLink(rawUrl, { transport: options.transport })
    } catch (error) {
      throw new Error(shortLinkFailureMessage(error))
    }
    const resolved = detectImportLink(url)
    if (!resolved) {
      throw new Error('Короткая ссылка ведёт на адрес, который mustplay не знает. Откройте её в браузере и скопируйте полный адрес.')
    }
    if (!resolved.supported) throw new Error(blockedLinkReason(resolved, yandexSaved))
    info = resolved
  }

  const ref = parsePlaylistUrl(url)
  if (!ref) {
    throw new Error('Не удалось прочитать ссылку. Подойдёт адрес плейлиста Deezer, Spotify или сета SoundCloud.')
  }
  if (ref.provider !== info.provider) {
    throw new Error(`Ссылка ведёт на ${pipelineProviderLabels[info.provider]}, но импорт этого адреса не поддерживается`)
  }
  return { ref: { ...ref, url }, info, short: Boolean(declared.short) }
}
