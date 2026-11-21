import { useEffect, useState } from 'react'
import { yandexLyricsFormats, yandexQualities } from '../../shared/contracts'
import type { YandexLyricsFormat, YandexQuality, YandexSettings } from '../../shared/contracts'
import type { PipelineSettingsPatch, PipelineStatus } from '../../shared/pipeline'
import { ProviderIcon } from './icons'
import { humanizeIpcError } from './ipc-error'

const qualityLabels: Record<YandexQuality, string> = {
  lq: 'Экономное (MP3/AAC)', nq: 'Высокое (MP3/AAC 320)', lossless: 'Lossless (FLAC)',
}
const lyricsLabels: Record<YandexLyricsFormat, string> = {
  none: 'Не сохранять', text: 'Текст в тегах', lrc: 'Синхронный .lrc',
}

export function SourceSettings({ section }: { section: 'sources' | 'files' | 'tools' }) {
  const [pipeline, setPipeline] = useState<PipelineStatus>()
  const [yandex, setYandex] = useState<YandexSettings>()
  const [clientId, setClientId] = useState('')
  const [key, setKey] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [awaitingSpotify, setAwaitingSpotify] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>()
  const settings = pipeline?.settings

  useEffect(() => {
    let current = true
    void window.mustplay.getPipelineStatus().then(value => {
      if (!current) return
      setPipeline(value)
      setClientId(value.settings.spotifyClientId)
    }).catch(() => {
      if (current) setNotice({ text: 'Не удалось загрузить настройки импорта.', error: true })
    })
    void window.mustplay.getYandexSettings().then(value => { if (current) setYandex(value) }).catch(() => {
      if (current) setNotice({ text: 'Не удалось загрузить настройки Яндекс Музыки.', error: true })
    })
    return () => { current = false }
  }, [])

  useEffect(() => {
    if (!awaitingSpotify) return
    let current = true
    const poll = setInterval(() => {
      void window.mustplay.getPipelineStatus().then(value => {
        if (!current || !value.settings.spotifyConnected) return
        setPipeline(value)
        setAwaitingSpotify(false)
        setNotice({ text: 'Spotify подключён.' })
      }).catch(() => {})
    }, 1500)
    const stop = setTimeout(() => {
      setAwaitingSpotify(false)
      setNotice({ text: 'Spotify не подтвердил вход. Проверьте, что порт 8888 свободен, и повторите.', error: true })
    }, 120_000)
    return () => { current = false; clearInterval(poll); clearTimeout(stop) }
  }, [awaitingSpotify])

  async function run(action: () => Promise<void>, success = 'Сохранено.') {
    setBusy(true)
    setNotice(undefined)
    try {
      await action()
      if (success) setNotice({ text: success })
    } catch (error) {
      setNotice({ text: humanizeIpcError(error, 'Не удалось выполнить действие.'), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function savePipeline(patch: PipelineSettingsPatch) {
    const saved = await window.mustplay.savePipelineSettings(patch)
    setPipeline(previous => previous && { ...previous, settings: saved })
  }

  async function updateYandex(action: () => Promise<unknown>) {
    await action()
    setYandex(await window.mustplay.getYandexSettings())
  }

  return <>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'notice notice-error' : 'notice'}>{notice.text}</p>}
    <section hidden={section !== 'sources'} className="settings-card settings-group" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Источники и подключения</h2>
      <div className="settings-subgroup">
        <h3><ProviderIcon provider="yandex" />Яндекс Музыка</h3>
        <p className="muted">{yandex?.hasToken ? 'Токен сохранён' : 'Токен нужен для поиска и загрузок.'}</p>
        <form className="settings-actions" onSubmit={event => {
          event.preventDefault()
          if (busy || !token.trim()) return
          void run(async () => {
            setYandex(await window.mustplay.setYandexToken(token.trim()))
            setToken('')
          }, 'Токен Яндекс Музыки сохранён.')
        }}>
          <input className="settings-input" type="password" aria-label="Токен Яндекс Музыки" autoComplete="off"
            spellCheck={false} placeholder={yandex?.hasToken ? 'Вставьте новый токен' : 'OAuth-токен'}
            value={token} onChange={event => setToken(event.currentTarget.value)} disabled={!yandex || busy} />
          <button type="submit" className="secondary" disabled={!yandex || busy || !token.trim()}>Сохранить токен</button>
          {yandex?.hasToken && <button type="button" className="text-button" disabled={busy}
            onClick={() => void run(async () => {
              setYandex(await window.mustplay.setYandexToken(''))
              setToken('')
            }, 'Токен удалён.')}>Забыть токен</button>}
        </form>
        <p className="muted">Введите OAuth-токен, полученный через доверенное приложение Яндекса.</p>
      </div>
      <div className="settings-subgroup">
        <h3>AcoustID</h3>
        {settings && <p className="muted" role="status">{settings.acoustidKeySource === 'custom'
          ? 'Используется пользовательский ключ' : 'Используется встроенный ключ'}</p>}
        <form className="settings-actions" onSubmit={event => {
          event.preventDefault()
          if (busy || !key.trim()) return
          void run(async () => { await savePipeline({ acoustidKey: key }); setKey('') })
        }}>
          <input className="settings-input" type="password" aria-label="Ключ AcoustID" maxLength={200} autoComplete="off"
            spellCheck={false} placeholder="Свой ключ AcoustID" value={key}
            onChange={event => setKey(event.currentTarget.value)} disabled={!settings || busy} />
          <button type="submit" className="secondary" disabled={!settings || busy || !key.trim()}>Сохранить ключ</button>
          {settings?.acoustidKeySource === 'custom' && <button type="button" className="text-button" disabled={busy}
            onClick={() => void run(async () => { await savePipeline({ acoustidKey: '' }); setKey('') })}>
            Вернуть встроенный ключ
          </button>}
        </form>
      </div>
      <div className="settings-subgroup">
        <h3><ProviderIcon provider="spotify" />Spotify Web API</h3>
        <p className="muted">{settings?.spotifyConnected ? 'Подключён' : 'Подключение необязательно для публичных плейлистов.'}</p>
        <form className="settings-actions" onSubmit={event => {
          event.preventDefault()
          if (busy || awaitingSpotify || !clientId.trim()) return
          void run(async () => {
            if (clientId.trim() !== settings?.spotifyClientId) await savePipeline({ spotifyClientId: clientId })
            await window.mustplay.connectPipelineSpotify()
            setAwaitingSpotify(true)
          }, 'Разрешите доступ в браузере и вернитесь в mustplay.')
        }}>
          <input className="settings-input" aria-label="Client ID Spotify" placeholder="Client ID"
            value={clientId} onChange={event => setClientId(event.currentTarget.value)}
            disabled={!settings || busy || awaitingSpotify || settings.spotifyConnected} />
          {settings?.spotifyConnected
            ? <button type="button" className="secondary" disabled={busy} onClick={() => void run(async () => {
                await window.mustplay.disconnectPipelineSpotify()
                setPipeline(await window.mustplay.getPipelineStatus())
              }, 'Spotify отключён.')}>Отключить</button>
            : <>
              <button type="submit" className="secondary" disabled={!settings || busy || awaitingSpotify || !clientId.trim()}>
                {awaitingSpotify ? 'Ждём подтверждения…' : 'Подключить'}
              </button>
              <button type="button" className="text-button"
                disabled={!settings || busy || awaitingSpotify || clientId.trim() === settings.spotifyClientId}
                onClick={() => void run(() => savePipeline({ spotifyClientId: clientId }))}>Сохранить Client ID</button>
            </>}
        </form>
        <p className="muted">Redirect URI для Spotify Developer Dashboard <code>http://127.0.0.1:8888/callback</code></p>
      </div>
    </section>
    <section hidden={section !== 'files'} className="settings-card settings-group" aria-labelledby="files-heading">
      <h2 id="files-heading">Импорт и файлы</h2>
      <p className="muted">Папки загрузок задают место сохранения файлов. Папки для сканирования добавляются в Библиотеке.</p>
      {settings && <div className="settings-subgroup">
        <h3>Импорт плейлистов</h3>
        <DownloadFolder title="Папка импорта плейлистов" settings={settings} busy={busy}
          choose={() => void run(async () => {
            const value = await window.mustplay.choosePipelineFolder()
            if (value) setPipeline(previous => previous && { ...previous, settings: value })
          }, '')}
          reset={() => void run(async () => {
            const value = await window.mustplay.resetPipelineFolder()
            setPipeline(previous => previous && { ...previous, settings: value })
          })} />
        <label className="settings-option">
          <span>Формат файлов</span>
          <select className="settings-input player-select" value={settings.format} disabled={busy}
            onChange={event => {
              const format = event.currentTarget.value === 'original' ? 'original' : 'm4a'
              void run(() => savePipeline({ format }))
            }}>
            <option value="m4a">M4A</option>
            <option value="original">Оригинал</option>
          </select>
        </label>
        <label className="settings-option">
          <span>Параллельные загрузки</span>
          <select className="settings-input player-select" value={settings.workers} disabled={busy}
            onChange={event => {
              const workers = Number(event.currentTarget.value)
              void run(() => savePipeline({ workers }))
            }}>
            {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}
          </select>
        </label>
      </div>}
      {yandex && <div className="settings-subgroup">
        <h3><ProviderIcon provider="yandex" />Загрузки Яндекс Музыки</h3>
        <DownloadFolder title="Папка загрузок Яндекс Музыки" settings={yandex} busy={busy}
          choose={() => void run(async () => setYandex(await window.mustplay.chooseYandexFolder()), '')}
          reset={() => void run(async () => setYandex(await window.mustplay.resetYandexFolder()))} />
        <label className="settings-option">
          <span>Качество загрузки</span>
          <select className="settings-input player-select" value={yandex.quality} aria-label="Качество загрузки" disabled={busy}
            onChange={event => {
              const quality = event.currentTarget.value as YandexQuality
              void run(() => updateYandex(() => window.mustplay.setYandexQuality(quality)))
            }}>
            {yandexQualities.map(value => <option key={value} value={value}>{qualityLabels[value]}</option>)}
          </select>
        </label>
        <label className="settings-option">
          <span>Формат текста песни</span>
          <select className="settings-input player-select" value={yandex.lyrics} aria-label="Формат текста песни" disabled={busy}
            onChange={event => {
              const lyrics = event.currentTarget.value as YandexLyricsFormat
              void run(() => updateYandex(() => window.mustplay.setYandexLyrics(lyrics)))
            }}>
            {yandexLyricsFormats.map(value => <option key={value} value={value}>{lyricsLabels[value]}</option>)}
          </select>
        </label>
        <label className="settings-option">
          <span>Встраивать обложку в файл</span>
          <input type="checkbox" aria-label="Встраивать обложку в файл" checked={yandex.embedCover} disabled={busy}
            onChange={event => {
              const enabled = event.currentTarget.checked
              void run(() => updateYandex(() => window.mustplay.setYandexEmbedCover(enabled)))
            }} />
        </label>
      </div>}
    </section>
    <section hidden={section !== 'tools'} className="settings-card settings-group" aria-labelledby="tools-heading">
      <h2 id="tools-heading">Модули и инструменты</h2>
      <p className="muted">Для импорта плейлистов mustplay использует yt-dlp и fpcalc. Они устанавливаются при первом импорте.</p>
      {pipeline && <ul className="settings-tool-list">
        {Object.entries(pipeline.tools).map(([name, tool]) => <li key={name}>
          <strong>{name === 'ytDlp' ? 'yt-dlp' : 'fpcalc'}</strong>
          <span className="muted">{tool.installed ? 'Готов к работе' : 'Не установлен'}</span>
        </li>)}
      </ul>}
      <button type="button" className="secondary" disabled={!settings || busy} onClick={() => void run(async () => {
        const tools = await window.mustplay.installPipelineTools()
        setPipeline(previous => previous && { ...previous, tools })
        if (!tools.ytDlp.installed || !tools.fpcalc.installed) throw new Error(
          [tools.ytDlp, tools.fpcalc].filter(tool => !tool.installed).map(tool => tool.hint).join(' '),
        )
      }, 'Инструменты готовы.')}>{busy ? 'Проверяем…' : 'Проверить и установить'}</button>
    </section>
  </>
}

function DownloadFolder({ title, settings, busy, choose, reset }: {
  title: string
  settings: Pick<YandexSettings, 'folderLabel' | 'folderAvailable' | 'usesDefaultFolder'>
  busy: boolean
  choose(): void
  reset(): void
}) {
  return <div className="settings-folder" role="group" aria-label={title}>
    <div className="settings-option">
      <span>Папка загрузок</span>
      <span className="muted">{settings.folderLabel}</span>
    </div>
    {!settings.folderAvailable && <p role="alert" className="danger">Папка недоступна. Выберите другой каталог.</p>}
    <div className="settings-actions">
      <button type="button" className="secondary" onClick={choose} disabled={busy}>Выбрать папку</button>
      <button type="button" className="text-button" onClick={reset} disabled={busy || settings.usesDefaultFolder}>
        Восстановить стандартную папку
      </button>
    </div>
  </div>
}
