import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  PipelineItemView, PipelineItemStatus, PipelineJobView, PipelineJobSummary, PipelineProvider,
  PipelineStatus, WebSourceProvider, WebSourceState,
} from '../../shared/pipeline'
import { pipelineProviderLabels } from '../../shared/pipeline'
import { detectImportLink as readLink, importActionLabel, linkKindLabels, linkNote, linkSummary, supportedLinks } from '../../shared/import-links'
import { humanizeIpcError } from './ipc-error'
import { Icon, ProviderIcon } from './icons'

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

const jobLabels: Record<PipelineJobView['status'], string> = {
  running: 'Идёт импорт',
  done: 'Готово',
  failed: 'Прервано',
  cancelled: 'Остановлено',
}

const providerHints: Record<WebSourceProvider, string> = {
  ytmusic: 'YouTube Music',
  yandex: 'Яндекс Музыка',
  vk: 'ВК Музыка',
  soundcloud: 'SoundCloud',
}

const webTileHints = {
  ytmusic: 'нужен вход в Google',
  soundcloud: 'закрытые подборки',
}

/** Sources whose web session can finish an import today. */
const workingWebSources = ['ytmusic', 'soundcloud'] as const satisfies readonly WebSourceProvider[]

const activeStatuses: PipelineItemStatus[] = ['searching', 'downloading', 'verifying']

function summarize(job: PipelineJobView): PipelineJobSummary {
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

function itemQuery(item: PipelineItemView): string {
  return item.artist ? `${item.artist} — ${item.title}` : item.title
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return ''
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function countItems(items: readonly PipelineItemView[]) {
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

function methodLabel(item: PipelineItemView): string {
  if (item.cached) return 'уже было в библиотеке'
  if (item.method === 'isrc') return 'по коду трека'
  if (item.method === 'acoustid') return 'по отпечатку'
  return ''
}

interface Props {
  active: boolean
  openSettings: (target: 'sources' | 'files' | 'tools') => void
  onOpenPlaylist: (playlistId: string, play: boolean) => void
  onLibraryChanged: () => Promise<void>
}

export function ImportPanel({ active, openSettings, onOpenPlaylist, onLibraryChanged }: Props) {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [jobs, setJobs] = useState<PipelineJobSummary[]>([])
  const [activeJob, setActiveJob] = useState<PipelineJobView | null>(null)
  const [url, setUrl] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error' | null>(null)
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState('')
  const [webSource, setWebSource] = useState<WebSourceState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const stage = useRef<HTMLDivElement>(null)
  const urlInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const notifiedDone = useRef<string | null>(null)
  const refreshLibrary = useEffectEvent(onLibraryChanged)

  useEffect(() => {
    mounted.current = true
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

  useEffect(() => {
    if (!active) return
    let current = true
    void window.mustplay.getPipelineStatus().then(state => {
      if (!current) return
      setStatus(state)
      if (state.job?.status === 'running') setActiveJob(previous => previous ?? state.job)
    }).catch(() => {
      if (current) {
        setNotice('Не удалось проверить готовность импорта.')
        setNoticeKind('error')
      }
    })
    return () => { current = false }
  }, [active])

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
          void refreshLibrary()
        }
        if (job.status === 'failed' && job.message) {
          setNotice(job.message)
          setNoticeKind('error')
        }
      }).catch(() => {})
    }, 1200)
    return () => clearInterval(timer)
  }, [runningId])

  useEffect(() => {
    if (!runningId) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [runningId])

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

  function clearUrl() {
    setUrl('')
    setNotice('')
    setNoticeKind(null)
    urlInput.current?.focus()
  }

  function acceptJob(job: PipelineJobView) {
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
      setNotice(linkNote(link, false))
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

  async function retryItem(item: PipelineItemView) {
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

  async function skipItem(item: PipelineItemView) {
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
  const folderUnavailable = status?.settings.folderAvailable === false
  const settingsTarget = folderUnavailable || (noticeKind === 'error' && /папка загрузок/i.test(notice))
    ? 'files'
    : noticeKind === 'error' && /AcoustID/i.test(notice) ? 'sources'
      : noticeKind === 'error' && /инструмент|yt-dlp|fpcalc/i.test(notice) ? 'tools' : undefined
  const link = useMemo(() => readLink(url), [url])
  const percent = activeJob && activeJob.total > 0 ? Math.min(100, Math.round((counts.done / activeJob.total) * 100)) : 0
  const running = activeJob?.status === 'running'
  const current = counts.active[0] ?? null
  const webLabel = webSource?.provider ? providerHints[webSource.provider] : 'Сервис'
  const linkBlocked = !link?.supported || folderUnavailable

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
          <button type="button" className="primary" onClick={importWebSource} disabled={busy || folderUnavailable}>
            {busy ? 'Читаем…' : 'Импортировать плейлист'}
          </button>
          <button type="button" className="secondary" onClick={clearWebData} disabled={busy}>Выйти и удалить данные</button>
          <button type="button" className="secondary" onClick={closeWebSource}>Закрыть</button>
        </div>
      </header>
      <p className={`notice${noticeKind === 'error' ? ' notice-error' : ''}`} role="status">
        {notice || 'Откройте страницу плейлиста в этом окне, затем нажмите «Импортировать плейлист».'}
      </p>
      {settingsTarget && <button type="button" className="secondary self-start" onClick={() => openSettings(settingsTarget)}>Открыть настройки</button>}
      <div className="import-web-frame" aria-hidden="true" />
    </div>
  }

  return <section className="import-panel" aria-label="Импорт из плейлистов">
    <header className="section-heading import-heading">
      <div>
        <h1>Импорт музыки</h1>
        <p className="muted">Добавьте плейлист из музыкального сервиса в свою библиотеку.</p>
      </div>
    </header>

    {notice && <p className={`notice${noticeKind === 'error' ? ' notice-error' : ''}`} role="alert">{notice}</p>}

    <form className="settings-card import-link-card" onSubmit={event => {
      event.preventDefault()
      if (!busy && !running && !linkBlocked) void startImport()
    }}>
      <label className="import-link-label" htmlFor="import-url">Ссылка на плейлист</label>
      <div className={`import-url-field${link ? ' is-known' : ''}`}>
        <span className="import-provider-mark" data-provider={link?.provider ?? 'unknown'} aria-hidden="true">
          <ProviderIcon provider={link?.provider} />
        </span>
        <input id="import-url" ref={urlInput} className="import-url-input" autoComplete="off" spellCheck={false}
          placeholder="https://soundcloud.com/artist/sets/name"
          value={url} inputMode="url" aria-describedby="import-link-hint" onChange={event => setUrl(event.currentTarget.value)} />
        {url && <button type="button" className="import-clear" aria-label="Очистить ссылку" onClick={clearUrl}>×</button>}
      </div>
      <p id="import-link-hint" className={`import-link-hint${url && !link ? ' is-error' : ''}`} role={url && !link ? 'alert' : undefined}>
        {link
          ? `${linkSummary(link)} · ${link.provider === 'yandex'
            ? 'Импорт по ссылке недоступен. Треки можно найти во вкладке «Поиск».'
            : linkNote(link, false)}`
          : url
            ? 'Не узнали сервис. Подойдёт ссылка на плейлист Deezer, Spotify или сет SoundCloud.'
            : 'Сервис определится по ссылке.'}
      </p>
      <div className="import-link-actions">
        {settingsTarget && <div>
          {folderUnavailable && <p className="danger">Папка загрузок недоступна.</p>}
          <button type="button" className="text-button" onClick={() => openSettings(settingsTarget)}>
            {settingsTarget === 'files' ? 'Выбрать папку в настройках' : 'Открыть настройки'}
          </button>
        </div>}
        <button type="submit" className="primary" disabled={busy || running || linkBlocked}>
          {running ? 'Импорт идёт…' : busy ? 'Готовим…' : importActionLabel(link)}
        </button>
      </div>

      <div className="import-supported">
        <span className="import-supported-label">Подойдут ссылки</span>
        <ul className="import-supported-list">
          {supportedLinks.map(item => <li key={item.provider}
            className={`import-supported-item${link?.provider === item.provider && link.supported ? ' is-active' : ''}`}>
            <span className="import-supported-mark" aria-hidden="true"><ProviderIcon provider={item.provider} /></span>
            <span className="import-supported-text">
              <strong>{pipelineProviderLabels[item.provider]}</strong>
              <span className="muted">{linkKindLabels[item.kind]} · {item.example}</span>
            </span>
          </li>)}
        </ul>
      </div>
    </form>

    <section className="settings-card import-accounts">
      <div className="import-accounts-head">
        <h2>Или через аккаунт сервиса</h2>
        <p className="muted">
          Войдите на странице сервиса, чтобы открыть плейлист своего аккаунта.
        </p>
      </div>
      <div className="import-tiles">
        {workingWebSources.map(provider => <button key={provider} type="button" className="import-tile"
          onClick={() => void openWebSource(provider)} disabled={busy || running || folderUnavailable}>
          <span className="import-tile-mark" aria-hidden="true"><ProviderIcon provider={provider} /></span>
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

    {activeJob && <section className="settings-card">
      <header className="import-log-head">
        <h2>Треки</h2>
        {!folderUnavailable && <button type="button" className="text-button"
          onClick={() => void window.mustplay.openPipelineFolder().catch(error => {
            setNotice(humanizeIpcError(error, 'Не удалось открыть папку загрузок.'))
            setNoticeKind('error')
          })}>Открыть папку с аудио</button>}
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


  </section>
}
