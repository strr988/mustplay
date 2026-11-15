import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  PipelineItem, PipelineItemStatus, PipelineJob, PipelineJobSummary,
  PipelineSettings, PipelineStatus, WebSourceState,
} from '../../shared/pipeline'
import { pipelineProviderLabels } from '../../shared/pipeline'

const emptySettings: PipelineSettings = {
  spotifyClientId: '',
  acoustidKey: '',
  downloadDir: '',
  workers: 3,
  spotifyConnected: false,
}

const emptyTools: PipelineStatus['tools'] = {
  ytDlp: { name: 'ytDlp', installed: false, hint: 'Проверяем…' },
  fpcalc: { name: 'fpcalc', installed: false, hint: 'Проверяем…' },
}

const itemLabels: Record<PipelineItemStatus, string> = {
  pending: 'В очереди',
  searching: 'Ищем аудио',
  downloading: 'Скачиваем',
  verifying: 'Проверяем отпечаток',
  verified: 'Подтверждён',
  rejected: 'Отброшен',
  failed: 'Ошибка',
  skipped: 'Пропущен',
}

const jobLabels: Record<PipelineJob['status'], string> = {
  running: 'Идёт импорт',
  done: 'Завершён',
  failed: 'Ошибка',
  cancelled: 'Остановлен',
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
  }
}

function itemQuery(item: PipelineItem): string {
  return item.artist ? `${item.artist} — ${item.title}` : item.title
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

export function ImportPanel({ active }: { active: boolean }) {
  const [status, setStatus] = useState<PipelineStatus | null>(null)
  const [jobs, setJobs] = useState<PipelineJobSummary[]>([])
  const [activeJob, setActiveJob] = useState<PipelineJob | null>(null)
  const [url, setUrl] = useState('')
  const [clientId, setClientId] = useState('')
  const [acoustidKey, setAcoustidKey] = useState('')
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error' | null>(null)
  const [busy, setBusy] = useState(false)
  const [awaitingSpotify, setAwaitingSpotify] = useState(false)
  const [webSource, setWebSource] = useState<WebSourceState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const stage = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void window.mustplay.getPipelineStatus().then(state => {
      if (!mounted.current) return
      setStatus(state)
      setClientId(state.settings.spotifyClientId)
      setAcoustidKey(state.settings.acoustidKey)
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
  }

  async function saveField<K extends keyof PipelineSettings>(key: K, value: PipelineSettings[K]) {
    const saved = await window.mustplay.savePipelineSettings({ [key]: value } as Partial<PipelineSettings>)
    setStatus(previous => (previous ? { ...previous, settings: saved } : previous))
    setNotice('Настройка сохранена.')
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
      setNotice(error instanceof Error ? error.message : 'Не удалось открыть авторизацию Spotify.')
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
        setNotice(error instanceof Error ? error.message : 'Не удалось установить инструменты.')
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
    if (!url.trim()) { setNotice('Вставьте ссылку на плейлист.'); setNoticeKind('error'); return }
    if (!acoustidKey.trim()) { setNotice('Укажите ключ AcoustID.'); setNoticeKind('error'); return }
    if (!status?.settings.downloadDir) { setNotice('Выберите папку для аудио.'); setNoticeKind('error'); return }
    if (!status?.tools.ytDlp.installed || !status.tools.fpcalc.installed) {
      setNotice('Сначала установите инструменты (yt-dlp и fpcalc).')
      setNoticeKind('error')
      return
    }
    setBusy(true)
    setNotice('')
    try {
      const job = await window.mustplay.startPipelineImport(url.trim())
      if (!mounted.current) return
      acceptJob(job)
      setNotice(`Импорт запущен: ${job.playlistName}`)
      setNoticeKind('ok')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось начать импорт.')
      setNoticeKind('error')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  async function openWebSource() {
    setBusy(true)
    setNotice('')
    try {
      const state = await window.mustplay.openWebSource('ytmusic')
      if (!mounted.current) return
      setWebSource(state)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось открыть YT Music.')
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
      setNotice(error instanceof Error ? error.message : 'Не удалось прочитать плейлист в веб-сессии.')
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
    setNotice('Сессия YT Music удалена: cookies и кэш очищены.')
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

  const items = activeJob?.items ?? []
  const counts = useMemo(() => countItems(items), [items])
  const settings = status?.settings ?? emptySettings
  const tools = status?.tools ?? emptyTools
  const percent = activeJob && activeJob.total > 0 ? Math.min(100, Math.round((counts.done / activeJob.total) * 100)) : 0
  const running = activeJob?.status === 'running'
  const current = counts.active[0] ?? null

  if (webSource?.open) {
    return <div className="import-web-stage" ref={stage} aria-label="Импорт из YT Music">
      <header className="import-web-head">
        <div className="import-web-title">
          <h1>YT Music</h1>
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
        <p className="muted">Плейлист → ISRC → аудио → отпечаток → локальная копия с логом по каждому треку.</p>
      </div>
      <div className="import-head-badges">
        <span className={`import-badge${tools.ytDlp.installed && tools.fpcalc.installed ? ' is-ready' : ''}`}>
          {tools.ytDlp.installed && tools.fpcalc.installed ? 'Инструменты готовы' : 'Нужны инструменты'}
        </span>
        {settings.spotifyConnected && <span className="import-badge is-ready">Spotify подключён</span>}
      </div>
    </header>

    {notice && <p className={`notice${noticeKind === 'error' ? ' notice-error' : ''}`} role="alert">{notice}</p>}

    <div className="import-grid">
      <section className="settings-card">
        <h2>Плейлист</h2>
        <label className="import-field">
          <span>Ссылка Deezer или Spotify</span>
          <input className="settings-input import-input" placeholder="https://www.deezer.com/playlist/… или open.spotify.com/playlist/…"
            value={url} onChange={event => setUrl(event.currentTarget.value)} />
        </label>
        <div className="settings-actions">
          <button type="button" className="primary" onClick={startImport} disabled={busy || running}>
            {running ? 'Импорт идёт…' : 'Начать импорт'}
          </button>
          <button type="button" className="secondary" onClick={openWebSource} disabled={busy || running}>
            Открыть YT Music
          </button>
        </div>
        <p className="muted">
          Deezer отдаёт список открыто. Spotify читается с публичной страницы — до 100 треков и без ISRC,
          поэтому код находится через Deezer и MusicBrainz.
        </p>
        <p className="muted">
          YT Music открывается в отдельном окне на вашей сессии: приложение не видит пароль, только cookies.
        </p>
      </section>

      <section className="settings-card">
        <h2>Проверка</h2>
        <label className="import-field">
          <span>Ключ AcoustID</span>
          <input className="settings-input import-input" placeholder="из acoustid.org" value={acoustidKey}
            onChange={event => setAcoustidKey(event.currentTarget.value)}
            onBlur={() => void saveField('acoustidKey', acoustidKey)} />
        </label>
        <div className="settings-option import-option">
          <div>
            <span>Папка для аудио</span>
            <p className="muted import-path">{settings.downloadDir || 'не выбрана'}</p>
          </div>
          <button type="button" className="secondary" onClick={chooseFolder} disabled={busy}>Выбрать папку</button>
        </div>
        <label className="settings-option import-option">
          <span>Параллельных загрузок</span>
          <input type="number" className="settings-input" min={1} max={5} value={String(settings.workers)}
            onChange={event => void saveField('workers', Math.min(5, Math.max(1, Number(event.currentTarget.value) || 1)))} />
        </label>
        <div className="import-tools">
          <div>
            <strong>yt-dlp</strong>
            <p className={tools.ytDlp.installed ? 'muted' : 'danger'}>{tools.ytDlp.installed ? 'установлен' : tools.ytDlp.hint}</p>
          </div>
          <div>
            <strong>fpcalc (Chromaprint)</strong>
            <p className={tools.fpcalc.installed ? 'muted' : 'danger'}>{tools.fpcalc.installed ? 'установлен' : tools.fpcalc.hint}</p>
          </div>
          <button type="button" className="secondary" onClick={installTools} disabled={busy}>Установить инструменты</button>
        </div>
      </section>
    </div>

    <details className="settings-card import-details">
      <summary>
        <span>Spotify Web API <span className="muted">— необязательно, для Premium-аккаунтов</span></span>
      </summary>
      <p className="muted">
        Без подключения Spotify читается публичная страница плейлиста. Client ID нужен только для Web API:
        Redirect URI <code>http://127.0.0.1:8888/callback</code>, аккаунт добавлен в User Management.
      </p>
      <label className="import-field">
        <span>Client ID Spotify</span>
        <input className="settings-input import-input" placeholder="из developer.spotify.com" value={clientId}
          onChange={event => setClientId(event.currentTarget.value)}
          onBlur={() => void saveField('spotifyClientId', clientId)} />
      </label>
      <div className="settings-actions">
        {settings.spotifyConnected
          ? <span className="import-badge is-ready">Аккаунт подключён</span>
          : <button type="button" className="secondary" onClick={connectSpotify} disabled={busy || awaitingSpotify}>
            {awaitingSpotify ? 'Ждём подтверждения…' : 'Подключить Spotify'}
          </button>}
        {settings.spotifyConnected && <button type="button" className="secondary" onClick={disconnectSpotify} disabled={busy}>Отключить</button>}
      </div>
    </details>

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
          : <span className="muted">{running ? 'Готовим следующий трек…' : activeJob.message ?? 'Нет активного трека'}</span>}
      </div>

      <div className="import-counters">
        <div className="import-counter"><span>Подтверждено</span><strong>{counts.verified}</strong></div>
        <div className="import-counter"><span>Отброшено</span><strong>{counts.rejected}</strong></div>
        <div className="import-counter"><span>С ошибкой</span><strong>{counts.failed}</strong></div>
        <div className="import-counter"><span>Осталось</span><strong>{counts.pending}</strong></div>
      </div>

      <p className="muted import-timing">
        Треков: {counts.done} из {activeJob.total}
        {' · '}начато в {formatClock(activeJob.createdAt)}
        {' · '}{running ? 'прошло' : 'заняло'} {formatElapsed(activeJob.createdAt, activeJob.finishedAt, now)}
      </p>
    </section>}

    <section className="settings-card">
      <h2>Задания</h2>
      {jobs.length === 0
        ? <p className="muted">Заданий пока нет. Начните с публичного плейлиста Deezer или Spotify.</p>
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
        <h2>Лог треков</h2>
        {settings.downloadDir && <button type="button" className="text-button"
          onClick={() => void window.mustplay.openPipelineFolder()}>Открыть папку с аудио</button>}
      </header>
      <div className="import-log">
        {items.map(item => <div key={item.id} className="import-log-row" data-status={item.status}>
          <span className="import-log-position">{item.position + 1}</span>
          <div className="import-log-main">
            <strong>{item.title}</strong>
            <span className="muted">
              {item.artist ?? '—'}
              {item.album ? ` · ${item.album}` : ''}
              {item.isrc ? ` · ISRC ${item.isrc}` : ''}
            </span>
            <span className="import-log-message">{item.filePath ?? item.message}</span>
          </div>
          <div className="import-log-state">
            <span>{itemLabels[item.status]}</span>
            <span className="muted">
              {item.method !== 'none' ? item.method : '—'}
              {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ''}
            </span>
          </div>
        </div>)}
      </div>
    </section>}
  </section>
}
