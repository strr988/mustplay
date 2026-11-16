import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  PipelineItem, PipelineItemStatus, PipelineJob, PipelineJobSummary, PipelineProvider,
  PipelineSettings, PipelineStatus, WebSourceProvider, WebSourceState,
} from '../../shared/pipeline'
import { pipelineProviderLabels } from '../../shared/pipeline'
import { detectImportLink as readLink, importActionLabel, linkKindLabels, linkNote, linkSummary, supportedLinks } from '../../shared/import-links'
import { humanizeIpcError } from './ipc-error'

const emptySettings: PipelineSettings = {
  spotifyClientId: '',
  acoustidKey: '',
  yandexToken: '',
  downloadDir: '',
  workers: 3,
  format: 'm4a',
  spotifyConnected: false,
}

const emptyTools: PipelineStatus['tools'] = {
  ytDlp: { name: 'ytDlp', installed: false, hint: 'Проверяем…' },
  fpcalc: { name: 'fpcalc', installed: false, hint: 'Проверяем…' },
}

const itemLabels: Record<PipelineItemStatus, string> = {
  pending: 'В очереди',
  searching: 'Ищем трек',
  downloading: 'Скачиваем',
  verifying: 'Сверяем запись',
  verified: 'Готово',
  rejected: 'Не подтверждено',
  failed: 'Не удалось скачать',
  skipped: 'Пропущено',
}

const jobLabels: Record<PipelineJob['status'], string> = {
  running: 'Идёт импорт',
  done: 'Готово',
  failed: 'Прервано',
  cancelled: 'Остановлено',
}

const providerHints: Record<WebSourceProvider, string> = {
  ytmusic: 'YT Music',
  yandex: 'Яндекс Музыка',
  vk: 'ВК Музыка',
  soundcloud: 'SoundCloud',
}

const webTileHints: Record<WebSourceProvider, string> = {
  ytmusic: 'нужен вход в Google',
  yandex: 'нужен OAuth-токен',
  vk: 'скоро',
  soundcloud: 'закрытые подборки',
}

/** Sources whose web session can finish an import today. */
const workingWebSources: readonly WebSourceProvider[] = ['ytmusic', 'soundcloud']

const providerMarks: Record<PipelineProvider, string> = {
  deezer: 'D',
  spotify: 'S',
  apple: 'A',
  yandex: 'Я',
  vk: 'VK',
  soundcloud: 'SC',
  ytmusic: 'YT',
}

const activeStatuses: PipelineItemStatus[] = ['searching', 'downloading', 'verifying']

function summarize(job: PipelineJob): PipelineJobSummary {
  return {
    id: job.id,
    provider: job.provider,
    playlistName: job.playlistName,
    status: job.status,
    total: job.total,
    verified: job.items.filter(item => item.status === 'verified').length,
    createdAt: job.createdAt,
    playlistId: job.playlistId,
  }
}

function itemQuery(item: PipelineItem): string {
  return item.artist ? `${item.artist} — ${item.title}` : item.title
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return ''
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function countItems(items: readonly PipelineItem[]) {
  const count = (status: PipelineItemStatus) => items.filter(item => item.status === status).length
  const verified = count('verified')
  const rejected = count('rejected')
  const failed = count('failed')
  const skipped = count('skipped')
  return {
    verified, rejected, failed, skipped,
    pending: count('pending') + count('searching') + count('downloading') + count('verifying'),
    done: verified + rejected + failed + skipped,
    active: items.filter(item => activeStatuses.includes(item.status)),
  }
}

function formatClock(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatElapsed(createdAt: string, finishedAt: string | null, now: number): string {
  const start = new Date(createdAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : now
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '0:00'
  const seconds = Math.max(0, Math.round((end - start) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function methodLabel(item: PipelineItem): string {
  if (item.cached) return 'уже было в библиотеке'
  if (item.method === 'isrc') return 'по коду трека'
  if (item.method === 'acoustid') return 'по отпечатку'
  return ''
}

interface Props {
  active: boolean
  onOpenPlaylist: (playlistId: string, play: boolean) => void
  onLibraryChanged: () => Promise<void>
}

export function ImportPanel({ active, onOpenPlaylist, onLibraryChanged }: Props) {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [jobs, setJobs] = useState<PipelineJobSummary[]>([])
  const [activeJob, setActiveJob] = useState<PipelineJob | null>(null)
  const [url, setUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const [acoustidKey, setAcoustidKey] = useState('')
  const [yandexToken, setYandexToken] = useState('')
  const [yandexSaved, setYandexSaved] = useState(false)
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error' | null>(null)
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState('')
  const [awaitingSpotify, setAwaitingSpotify] = useState(false)
  const [webSource, setWebSource] = useState<WebSourceState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const stage = useRef<HTMLDivElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const tokenInput = useRef<HTMLInputElement>(null)
  const settingsCard = useRef<HTMLDetailsElement>(null)
  const mounted = useRef(true)
  const notifiedDone = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    void window.mustplay.getPipelineStatus().then(state => {
      if (!mounted.current) return
      setStatus(state)
      setClientId(state.settings.spotifyClientId)
      setAcoustidKey(state.settings.acoustidKey)
      setYandexSaved(state.yandexTokenSaved)
      if (state.job?.status === 'running') setActiveJob(state.job)
    }).catch(() => { if (mounted.current) setNotice('Не удалось загрузить настройки импорта.') })
    void window.mustplay.listPipelineJobs().then(list => {
      if (!mounted.current) return
      setJobs(list)
      if (list[0]) void window.mustplay.getPipelineJob(list[0].id).then(job => {
        if (mounted.current && job) setActiveJob(previous => previous ?? job)
      }).catch(() => {})
    }).catch(() => {})
    void window.mustplay.getWebSourceState().then(state => {
      if (mounted.current) setWebSource(state.open ? state : null)
    }).catch(() => {})
    return () => { mounted.current = false }
  }, [])

  const runningId = activeJob?.status === 'running' ? activeJob.id : null

  useEffect(() => {
    if (!runningId) return
    const timer = setInterval(() => {
      void window.mustplay.getPipelineJob(runningId).then(job => {
        if (!mounted.current || !job) return
        setActiveJob(job)
        setJobs(previous => previous.map(item => item.id === job.id ? summarize(job) : item))
        if (job.status === 'done' && notifiedDone.current !== job.id) {
          notifiedDone.current = job.id
          void onLibraryChanged()
        }
        if (job.status === 'failed' && job.message) {
          setNotice(job.message)
          setNoticeKind('error')
        }
      }).catch(() => {})
    }, 1200)
    return () => clearInterval(timer)
  }, [runningId, onLibraryChanged])

  useEffect(() => {
    if (!runningId) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runningId])

  useEffect(() => {
    if (!awaitingSpotify) return
    let cancelled = false
    const poll = setInterval(() => {
      void window.mustplay.getPipelineStatus().then(state => {
        if (cancelled || !state.settings.spotifyConnected) return
        setStatus(state)
        setAwaitingSpotify(false)
        setNotice('Spotify подключён.')
        setNoticeKind('ok')
      }).catch(() => {})
    }, 1500)
    const stop = setTimeout(() => {
      if (cancelled) return
      setAwaitingSpotify(false)
      setNotice('Spotify не подтвердил вход. Проверьте, что порт 8888 свободен, и повторите.')
      setNoticeKind('error')
    }, 120_000)
    return () => { cancelled = true; clearInterval(poll); clearTimeout(stop) }
  }, [awaitingSpotify])

  useEffect(() => {
    if (!webSource?.open) return
    let cancelled = false
    const poll = setInterval(() => {
      void window.mustplay.getWebSourceState().then(state => {
        if (cancelled) return
        setWebSource(state.open ? state : null)
      }).catch(() => {})
    }, 1500)
    return () => { cancelled = true; clearInterval(poll) }
  }, [webSource?.open])

  // The native view must follow the content area while the window resizes.
  useLayoutEffect(() => {
    if (!webSource?.open || !active) return
    const element = stage.current
    if (!element) return
    const content = element.closest('.content')
    if (!(content instanceof HTMLElement)) return
    const sync = () => {
      const rect = content.getBoundingClientRect()
      element.style.left = `${rect.left}px`
      element.style.top = `${rect.top}px`
      element.style.width = `${rect.width}px`
      element.style.height = `${rect.height}px`
      const frame = element.querySelector('.import-web-frame')
      if (frame instanceof HTMLElement) {
        const frameRect = frame.getBoundingClientRect()
        void window.mustplay.setWebSourceBounds({
          x: frameRect.left, y: frameRect.top, width: frameRect.width, height: frameRect.height,
        })
      }
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(content)
    observer.observe(element)
    window.addEventListener('resize', sync)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [webSource?.open, active])

  useEffect(() => {
    if (active || !webSource) return
    void window.mustplay.closeWebSource()
    setWebSource(null)
  }, [active, webSource])

  async function refreshStatus() {
    const state = await window.mustplay.getPipelineStatus()
    if (!mounted.current) return
    setStatus(state)
    setClientId(state.settings.spotifyClientId)
    setAcoustidKey(state.settings.acoustidKey)
    setYandexSaved(state.yandexTokenSaved)
  }

  async function saveYandexToken(token: string) {
    const trimmed = token.trim()
    if (!trimmed) return
    try {
      await window.mustplay.savePipelineSettings({ yandexToken: trimmed })
      setYandexToken('')
      await refreshStatus()
      setNotice('Токен Яндекс Музыки сохранён.')
      setNoticeKind('ok')
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось сохранить токен Яндекса.'))
      setNoticeKind('error')
    }
  }

  async function forgetYandexToken() {
    try {
      await window.mustplay.savePipelineSettings({ yandexToken: '' })
      setYandexToken('')
      await refreshStatus()
      setNotice('Токен Яндекс Музыки удалён.')
      setNoticeKind('ok')
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось удалить токен Яндекса.'))
      setNoticeKind('error')
    }
  }

  /** Opens the settings and brings them into view. */
  function openSettings() {
    setSettingsOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      settingsCard.current?.scrollIntoView({ block: 'start' })
    }))
  }

  /** Opens the settings and puts the cursor into the token field. */
  function focusYandexToken() {
    setSettingsOpen(true)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      tokenInput.current?.scrollIntoView({ block: 'center' })
      tokenInput.current?.focus()
    }))
  }

  function clearUrl() {
    setUrl('')
    setNotice('')
    setNoticeKind(null)
    urlInput.current?.focus()
  }

  async function saveField<K extends keyof PipelineSettings>(key: K, value: PipelineSettings[K]) {
    const saved = await window.mustplay.savePipelineSettings({ [key]: value } as Partial<PipelineSettings>)
    setStatus(previous => (previous ? { ...previous, settings: saved } : previous))
    setNotice('Сохранено.')
    setNoticeKind('ok')
  }

  async function chooseFolder() {
    const saved = await window.mustplay.choosePipelineFolder()
    if (!saved || !mounted.current) return
    setStatus(previous => (previous ? { ...previous, settings: saved } : previous))
    setNotice('Папка для аудио выбрана.')
    setNoticeKind('ok')
  }

  async function connectSpotify() {
    if (!clientId.trim()) {
      setNotice('Введите Client ID Spotify.')
      setNoticeKind('error')
      return
    }
    try {
      await window.mustplay.connectPipelineSpotify()
      setAwaitingSpotify(true)
      setNotice('Открыли браузер. Разрешите доступ к плейлистам и вернитесь в mustplay.')
      setNoticeKind('ok')
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось открыть авторизацию Spotify.'))
      setNoticeKind('error')
    }
  }

  async function disconnectSpotify() {
    await window.mustplay.disconnectPipelineSpotify()
    await refreshStatus()
    setNotice('Spotify отключён.')
    setNoticeKind('ok')
  }

  async function installTools() {
    setBusy(true)
    setNotice('Устанавливаем инструменты из официальных релизов…')
    setNoticeKind('ok')
    try {
      const tools = await window.mustplay.installPipelineTools()
      if (!mounted.current) return
      setStatus(previous => (previous ? { ...previous, tools } : previous))
      const ready = tools.ytDlp.installed && tools.fpcalc.installed
      setNotice(ready ? 'Инструменты готовы.' : 'Не все инструменты установлены. Смотрите подсказки ниже.')
      setNoticeKind(ready ? 'ok' : 'error')
    } catch (error) {
      if (mounted.current) {
        setNotice(humanizeIpcError(error, 'Не удалось установить инструменты.'))
        setNoticeKind('error')
      }
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  function acceptJob(job: PipelineJob) {
    setActiveJob(job)
    setNow(Date.now())
    setJobs(previous => [summarize(job), ...previous.filter(item => item.id !== job.id)])
  }

  async function startImport() {
    if (!link) {
      setNotice('Не узнали сервис по ссылке. Пример: https://soundcloud.com/artist/sets/name')
      setNoticeKind('error')
      urlInput.current?.focus()
      return
    }
    if (!link.supported) {
      setNotice(linkNote(link, yandexSaved))
      setNoticeKind('error')
      return
    }
    setBusy(true)
    setNotice('Готовим инструменты и читаем плейлист…')
    setNoticeKind('ok')
    try {
      const job = await window.mustplay.startPipelineImport(url.trim())
      if (!mounted.current) return
      acceptJob(job)
      setNotice(`Импорт запущен: ${job.playlistName}`)
      setNoticeKind('ok')
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось начать импорт.'))
      setNoticeKind('error')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function openWebSource(provider: WebSourceProvider) {
    setBusy(true)
    setNotice('')
    try {
      const state = await window.mustplay.openWebSource(provider)
      if (!mounted.current) return
      setWebSource(state)
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось открыть сервис.'))
      setNoticeKind('error')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function importWebSource() {
    setBusy(true)
    try {
      const job = await window.mustplay.importWebSourcePlaylist()
      if (!mounted.current) return
      await window.mustplay.closeWebSource()
      setWebSource(null)
      acceptJob(job)
      setNotice(`Импорт запущен: ${job.playlistName}`)
      setNoticeKind('ok')
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось прочитать плейлист в веб-сессии.'))
      setNoticeKind('error')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function closeWebSource() {
    await window.mustplay.closeWebSource()
    if (mounted.current) setWebSource(null)
  }

  async function clearWebData() {
    await window.mustplay.clearWebSourceData()
    if (!mounted.current) return
    setWebSource(null)
    setNotice('Сессия удалена: cookies и кэш очищены.')
    setNoticeKind('ok')
  }

  async function cancelImport() {
    await window.mustplay.cancelPipelineImport()
    setNotice('Импорт остановлен.')
    setNoticeKind('ok')
  }

  async function openJob(id: string) {
    const job = await window.mustplay.getPipelineJob(id)
    if (mounted.current && job) setActiveJob(job)
  }

  async function retryItem(item: PipelineItem) {
    if (!activeJob) return
    setRetrying(item.id)
    setNotice(item.status === 'rejected' ? 'Пробуем другую версию…' : 'Повторяем трек…')
    setNoticeKind('ok')
    try {
      const job = await window.mustplay.retryPipelineItem(activeJob.id, item.id)
      if (!mounted.current) return
      setActiveJob(job)
      setJobs(previous => previous.map(summary => summary.id === job.id ? summarize(job) : summary))
      const updated = job.items.find(entry => entry.id === item.id)
      if (updated?.status === 'verified') {
        setNotice('Трек добавлен в плейлист.')
        setNoticeKind('ok')
        void onLibraryChanged()
      } else if (updated?.status === 'rejected') {
        setNotice('Не удалось подтвердить и эту версию. Можно попробовать ещё раз позже.')
        setNoticeKind('error')
      } else if (updated?.status === 'failed') {
        setNotice(updated.message ?? 'Не удалось скачать трек.')
        setNoticeKind('error')
      }
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось повторить трек.'))
      setNoticeKind('error')
    } finally {
      if (mounted.current) setRetrying('')
    }
  }

  async function skipItem(item: PipelineItem) {
    if (!activeJob) return
    try {
      const job = await window.mustplay.skipPipelineItem(activeJob.id, item.id)
      if (!mounted.current) return
      setActiveJob(job)
      setJobs(previous => previous.map(summary => summary.id === job.id ? summarize(job) : summary))
      setNotice('Трек пропущен.')
      setNoticeKind('ok')
    } catch (error) {
      setNotice(humanizeIpcError(error, 'Не удалось пропустить трек.'))
      setNoticeKind('error')
    }
  }

  const items = activeJob?.items ?? []
  const counts = useMemo(() => countItems(items), [items])
  const settings = status?.settings ?? emptySettings
  const tools = status?.tools ?? emptyTools
  const link = useMemo(() => readLink(url), [url])
  const percent = activeJob && activeJob.total > 0 ? Math.min(100, Math.round((counts.done / activeJob.total) * 100)) : 0
  const running = activeJob?.status === 'running'
  const current = counts.active[0] ?? null
  const toolsReady = tools.ytDlp.installed && tools.fpcalc.installed
  const toolsHint = !tools.ytDlp.installed ? tools.ytDlp.hint : !tools.fpcalc.installed ? tools.fpcalc.hint : 'Готовы к работе'
  const webLabel = webSource?.provider ? providerHints[webSource.provider] : 'Сервис'
  const linkBlocked = !link || !link.supported
  const folderName = settings.downloadDir.split(/[\\/]/).filter(Boolean).pop() ?? 'папка не выбрана'
  const settingsSummary = [
    settings.format === 'm4a' ? 'm4a' : 'оригинал',
    folderName,
    toolsReady ? 'инструменты готовы' : 'инструменты не готовы',
    yandexSaved ? 'Яндекс: токен ✓' : 'Яндекс: без токена',
  ].join(' · ')

  if (webSource?.open) {
    return <div className="import-web-stage" ref={stage} aria-label={`Импорт из ${webLabel}`}>
      <header className="import-web-head">
        <div className="import-web-title">
          <h1>{webLabel}</h1>
          <p className="muted">
            {webSource.title || 'Войдите в аккаунт или откройте плейлист'}
            {webSource.url ? ` · ${webSource.url.replace(/^https:\/\//, '').slice(0, 64)}` : ''}
          </p>
        </div>
        <div className="settings-actions">
          <button type="button" className="primary" onClick={importWebSource} disabled={busy}>
            {busy ? 'Читаем…' : 'Импортировать плейлист'}
          </button>
          <button type="button" className="secondary" onClick={clearWebData} disabled={busy}>Выйти и удалить данные</button>
          <button type="button" className="secondary" onClick={closeWebSource}>Закрыть</button>
        </div>
      </header>
      <p className={`notice${noticeKind === 'error' ? ' notice-error' : ''}`} role="status">
        {notice || 'Откройте страницу плейлиста в этом окне, затем нажмите «Импортировать плейлист».'}
      </p>
      <div className="import-web-frame" aria-hidden="true" />
    </div>
  }

  return <section className="import-panel" aria-label="Импорт из плейлистов">
    <header className="section-heading import-heading">
      <div>
        <h1>Импорт музыки</h1>
        <p className="muted">Вставьте ссылку на плейлист — mustplay найдёт треки, проверит их и соберёт плейлист в вашей библиотеке.</p>
      </div>
    </header>

    {notice && <p className={`notice${noticeKind === 'error' ? ' notice-error' : ''}`} role="alert">{notice}</p>}

    <section className="settings-card import-link-card">
      <label className="import-link-label" htmlFor="import-url">Ссылка на плейлист</label>
      <div className={`import-url-field${link ? ' is-known' : ''}`}>
        <span className="import-provider-mark" data-provider={link?.provider ?? 'unknown'} aria-hidden="true">
          {link ? providerMarks[link.provider] : '↗'}
        </span>
        <input id="import-url" ref={urlInput} className="import-url-input import-input" autoComplete="off" spellCheck={false}
          placeholder="https://soundcloud.com/artist/sets/name"
          value={url} onChange={event => setUrl(event.currentTarget.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !busy && !running && !linkBlocked) void startImport() }} />
        {url && <button type="button" className="import-clear" aria-label="Очистить ссылку" onClick={clearUrl}>×</button>}
      </div>
      <p className={`import-link-hint${url && !link ? ' is-error' : ''}`} role={url && !link ? 'alert' : undefined}>
        {link
          ? `${linkSummary(link)} · ${linkNote(link, yandexSaved)}`
          : url
            ? 'Не узнали сервис. Подойдёт ссылка на плейлист Deezer, Spotify или сет SoundCloud.'
            : 'Вставьте ссылку — сервис определится сам. Enter начнёт импорт.'}
      </p>
      <div className="import-link-actions">
        <div className="import-link-meta">
          <span className="muted">Формат: {settings.format === 'm4a' ? 'm4a' : 'оригинал'}</span>
          <button type="button" className="text-button" onClick={openSettings}>Настройки</button>
          {link?.provider === 'yandex' && !yandexSaved &&
            <button type="button" className="text-button" onClick={focusYandexToken}>Сохранить токен</button>}
        </div>
        <button type="button" className="primary" onClick={startImport} disabled={busy || running || linkBlocked}>
          {running ? 'Импорт идёт…' : busy ? 'Готовим…' : importActionLabel(link)}
        </button>
      </div>

      <div className="import-supported">
        <span className="import-supported-label">Подойдут ссылки</span>
        <ul className="import-supported-list">
          {supportedLinks.map(item => <li key={item.provider}
            className={`import-supported-item${link?.provider === item.provider && link.supported ? ' is-active' : ''}`}>
            <span className="import-supported-mark" aria-hidden="true">{providerMarks[item.provider]}</span>
            <span className="import-supported-text">
              <strong>{pipelineProviderLabels[item.provider]}</strong>
              <span className="muted">{linkKindLabels[item.kind]} · {item.example}</span>
            </span>
          </li>)}
        </ul>
      </div>
      <p className="import-build">mustplay {status?.version ?? '…'} · сборка {status?.build ?? '…'}</p>
    </section>

    <section className="settings-card import-accounts">
      <div className="import-accounts-head">
        <h2>Или через аккаунт сервиса</h2>
        <p className="muted">
          Откроется настоящая страница сервиса внутри mustplay. Пароль вводится на его странице
          и приложению не виден.
        </p>
      </div>
      <div className="import-tiles">
        {workingWebSources.map(provider => <button key={provider} type="button" className="import-tile"
          onClick={() => void openWebSource(provider)} disabled={busy || running}>
          <span className="import-tile-mark" aria-hidden="true">{providerMarks[provider]}</span>
          <span className="import-tile-text">
            <strong>{providerHints[provider]}</strong>
            <span className="muted">{webTileHints[provider]}</span>
          </span>
          <span className="import-tile-arrow" aria-hidden="true">→</span>
        </button>)}
      </div>
    </section>

    {activeJob && <section className="settings-card import-progress" aria-label="Ход импорта">
      <header className="import-progress-head">
        <div>
          <h2>{activeJob.playlistName}</h2>
          <p className="muted">
            {pipelineProviderLabels[activeJob.provider]} · {jobLabels[activeJob.status]}
            {activeJob.sourceNote ? ` · ${activeJob.sourceNote}` : ''}
          </p>
        </div>
        <div className="settings-actions">
          <span className="import-percent" aria-hidden="true">{percent}%</span>
          {running && <button type="button" className="secondary" onClick={cancelImport}>Остановить</button>}
        </div>
      </header>

      <div className="import-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        aria-label="Прогресс импорта">
        <span className="import-bar-fill" style={{ width: `${percent}%` }} />
      </div>

      <div className="import-now" role="status">
        <span className="import-now-label">{running ? 'Сейчас импортируется' : 'Состояние'}</span>
        {current
          ? <span className="import-now-track">
            {itemQuery(current)} <span className="muted">· {itemLabels[current.status]}</span>
            {counts.active.length > 1 && <span className="muted"> · ещё {counts.active.length - 1}</span>}
          </span>
          : <span className="muted">{running ? 'Готовим следующий трек…' : activeJob.message ?? 'Импорт завершён'}</span>}
      </div>

      <div className="import-counters">
        <div className="import-counter"><span>Подтверждено</span><strong>{counts.verified}</strong></div>
        <div className="import-counter"><span>Не подтверждено</span><strong>{counts.rejected}</strong></div>
        <div className="import-counter"><span>С ошибкой</span><strong>{counts.failed}</strong></div>
        <div className="import-counter"><span>Осталось</span><strong>{counts.pending}</strong></div>
      </div>

      <p className="muted import-timing">
        Треков: {counts.done} из {activeJob.total}
        {' · '}начато в {formatClock(activeJob.createdAt)}
        {' · '}{running ? 'прошло' : 'заняло'} {formatElapsed(activeJob.createdAt, activeJob.finishedAt, now)}
      </p>

      {activeJob.status === 'done' && activeJob.playlistId && <div className="settings-actions import-result-actions">
        <button type="button" className="primary" onClick={() => onOpenPlaylist(activeJob.playlistId!, true)}>
          Слушать
        </button>
        <button type="button" className="secondary" onClick={() => onOpenPlaylist(activeJob.playlistId!, false)}>
          Открыть плейлист
        </button>
      </div>}
    </section>}

    <section className="settings-card">
      <h2>История</h2>
      {jobs.length === 0
        ? <p className="muted">Импортируйте первый плейлист — он появится здесь.</p>
        : <div className="import-job-list">
          {jobs.map(summary => <button key={summary.id} type="button" className="import-job"
            aria-current={summary.id === activeJob?.id ? 'true' : undefined}
            onClick={() => void openJob(summary.id)}>
            <span className="import-job-name">{summary.playlistName}</span>
            <span className="muted">{pipelineProviderLabels[summary.provider]}</span>
            <span className="import-job-status" data-status={summary.status}>{jobLabels[summary.status]}</span>
            <span className="import-job-count">{summary.verified} / {summary.total}</span>
          </button>)}
        </div>}
    </section>

    {activeJob && <section className="settings-card">
      <header className="import-log-head">
        <h2>Треки</h2>
        {settings.downloadDir && <button type="button" className="text-button"
          onClick={() => void window.mustplay.openPipelineFolder()}>Открыть папку с аудио</button>}
      </header>
      <div className="import-log">
        {items.map(item => <div key={item.id} className="import-log-row" data-status={item.status}>
          <span className="import-log-position">{item.position + 1}</span>
          <div className="import-log-main">
            <strong>{item.title}</strong>
            <span className="muted">
              {item.artist ?? 'неизвестный исполнитель'}
              {item.album ? ` · ${item.album}` : ''}
              {formatDuration(item.durationSeconds) ? ` · ${formatDuration(item.durationSeconds)}` : ''}
            </span>
            {item.status === 'rejected' && <span className="import-log-message">{item.message}</span>}
            {item.status === 'failed' && <span className="import-log-message">{item.message ?? 'Не удалось скачать'}</span>}
            <details className="import-log-details">
              <summary>Подробности</summary>
              <p className="muted">
                {item.cached
                  ? 'Этот трек уже был проверен раньше — скачивать заново не пришлось.'
                  : methodLabel(item) ? `Подтверждено ${methodLabel(item)}${item.confidence != null ? ` · совпадение ${Math.round(item.confidence * 100)}%` : ''}` : item.message}
                {item.isrc ? ` · код трека ${item.isrc}` : ''}
              </p>
            </details>
          </div>
          <div className="import-log-state">
            {item.cached && <span className="import-badge is-ready">Уже в библиотеке</span>}
            <span>{itemLabels[item.status]}</span>
            {(item.status === 'rejected' || item.status === 'failed') && <div className="import-log-actions">
              <button type="button" className="text-button" disabled={retrying === item.id}
                onClick={() => void retryItem(item)}>
                {retrying === item.id ? 'Пробуем…' : item.status === 'rejected' ? 'Другая версия' : 'Повторить'}
              </button>
              {item.status === 'rejected' && <button type="button" className="text-button" disabled={retrying === item.id}
                onClick={() => void skipItem(item)}>Пропустить</button>}
            </div>}
          </div>
        </div>)}
      </div>
    </section>}

    <details ref={settingsCard} className="settings-card import-settings" open={settingsOpen}
      onToggle={event => setSettingsOpen(event.currentTarget.open)}>
      <summary className="import-settings-head">
        <span>Настройки импорта</span>
        <span className="import-settings-summary">{settingsSummary}</span>
      </summary>

      <div className="import-settings-body">
        <section className="import-settings-group" aria-labelledby="import-tools-title">
          <h3 id="import-tools-title">Инструменты</h3>
          <div className="import-settings-row">
            <div className="import-tool-state">
              <span className="import-chip" data-ready={tools.ytDlp.installed || undefined}>yt-dlp</span>
              <span className="import-chip" data-ready={tools.fpcalc.installed || undefined}>fpcalc</span>
              <span className={toolsReady ? 'muted' : 'danger import-tool-hint'}>{toolsHint}</span>
            </div>
            <button type="button" className="secondary" onClick={installTools} disabled={busy}>
              {toolsReady ? 'Проверить снова' : 'Установить'}
            </button>
          </div>
        </section>

        <section className="import-settings-group" aria-labelledby="import-files-title">
          <h3 id="import-files-title">Файлы</h3>
          <div className="import-settings-row">
            <div>
              <span>Формат</span>
              <p className="muted">m4a играет везде, оригинал — без перекодирования.</p>
            </div>
            <div className="import-segmented" role="group" aria-label="Формат файлов">
              <button type="button" aria-pressed={settings.format === 'm4a'}
                onClick={() => void saveField('format', 'm4a')}>m4a</button>
              <button type="button" aria-pressed={settings.format === 'original'}
                onClick={() => void saveField('format', 'original')}>оригинал</button>
            </div>
          </div>
          <div className="import-settings-row">
            <div>
              <span>Параллельные загрузки</span>
              <p className="muted">Сколько треков качать одновременно, от 1 до 5.</p>
            </div>
            <select className="settings-input import-workers" aria-label="Параллельные загрузки"
              value={settings.workers}
              onChange={event => void saveField('workers', Math.min(5, Math.max(1, Number(event.currentTarget.value) || 1)))}>
              {[1, 2, 3, 4, 5].map(count => <option key={count} value={count}>{count}</option>)}
            </select>
          </div>
          <div className="import-settings-row">
            <div>
              <span>Папка для аудио</span>
              <p className="muted import-path">{settings.downloadDir || 'появится при первом импорте'}</p>
            </div>
            <button type="button" className="secondary" onClick={chooseFolder} disabled={busy}>Выбрать папку</button>
          </div>
        </section>

        <section className="import-settings-group" aria-labelledby="import-connections-title">
          <h3 id="import-connections-title">Подключения</h3>
          <div className="import-connection">
            <div className="import-connection-head">
              <span>Яндекс Музыка</span>
              {yandexSaved
                ? <span className="import-badge is-ready">Токен сохранён</span>
                : <span className="import-badge">Нужен токен</span>}
            </div>
            <div className="import-connection-body">
              <input ref={tokenInput} type="password" autoComplete="off" spellCheck={false}
                aria-label="Токен Яндекс Музыки" className="settings-input import-input"
                placeholder={yandexSaved ? 'токен сохранён — вставьте новый, чтобы заменить' : 'OAuth-токен'}
                value={yandexToken}
                onChange={event => setYandexToken(event.currentTarget.value)}
                onBlur={() => { if (yandexToken.trim()) void saveYandexToken(yandexToken) }} />
              {yandexSaved && <button type="button" className="secondary"
                onClick={() => void forgetYandexToken()} disabled={busy}>Забыть токен</button>}
            </div>
            <p className="muted">
              Где взять:{' '}
              <button type="button" className="text-button" onClick={() => void window.mustplay.openYandexTokenHelp()}>
                ym-token.marshal.dev
              </button>{' '}
              — сторонний сервис, он попросит вход в Яндекс-аккаунт. Без посредника: DevTools на
              music.yandex.ru → запрос к API → заголовок <code>Authorization</code>.
            </p>
          </div>
          <div className="import-connection">
            <div className="import-connection-head">
              <span>Spotify Web API</span>
              {settings.spotifyConnected
                ? <span className="import-badge is-ready">Подключён</span>
                : <span className="import-badge">Необязательно</span>}
            </div>
            <div className="import-connection-body">
              <input className="settings-input import-input" aria-label="Client ID Spotify"
                placeholder="Client ID из developer.spotify.com" value={clientId}
                onChange={event => setClientId(event.currentTarget.value)}
                onBlur={() => void saveField('spotifyClientId', clientId)} />
              {settings.spotifyConnected
                ? <button type="button" className="secondary" onClick={disconnectSpotify} disabled={busy}>Отключить</button>
                : <button type="button" className="secondary" onClick={connectSpotify} disabled={busy || awaitingSpotify}>
                  {awaitingSpotify ? 'Ждём подтверждения…' : 'Подключить'}
                </button>}
            </div>
            <p className="muted">
              Нужен только для Web API и Premium. Без него Spotify читается как публичная страница.
              Redirect URI: <code>http://127.0.0.1:8888/callback</code>.
            </p>
          </div>
        </section>

        <section className="import-settings-group" aria-labelledby="import-acoustid-title">
          <h3 id="import-acoustid-title">AcoustID</h3>
          <div className="import-settings-row">
            <div>
              <span>Ключ</span>
              <p className="muted">Встроенного хватает для сверки отпечатков; свой можно взять на acoustid.org.</p>
            </div>
            <input className="settings-input import-input" aria-label="Ключ AcoustID" placeholder="встроенный"
              value={acoustidKey} onChange={event => setAcoustidKey(event.currentTarget.value)}
              onBlur={() => void saveField('acoustidKey', acoustidKey)} />
          </div>
        </section>
      </div>
    </details>
  </section>
}
