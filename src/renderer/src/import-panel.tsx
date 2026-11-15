import { useEffect, useRef, useState } from 'react'
import type { PipelineJob, PipelineJobSummary, PipelineSettings, PipelineStatus } from '../../shared/pipeline'
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

export function ImportPanel() {
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
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void window.mustplay.getPipelineStatus().then(state => {
      if (!mounted.current) return
      setStatus(state)
      setClientId(state.settings.spotifyClientId)
      setAcoustidKey(state.settings.acoustidKey)
    }).catch(() => { if (mounted.current) setNotice('Не удалось загрузить настройки импорта.') })
    void window.mustplay.listPipelineJobs().then(list => {
      if (!mounted.current) return
      setJobs(list)
      if (list[0]) void window.mustplay.getPipelineJob(list[0].id).then(job => {
        if (mounted.current && job) setActiveJob(job)
      }).catch(() => {})
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
      setNotice(ready ? 'Инструменты готовы.' : 'Не все инструменты установлены. Смотрите подсказки выше.')
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

  async function startImport() {
    if (!url.trim()) { setNotice('Вставьте ссылку на плейлист.'); setNoticeKind('error'); return }
    if (!acoustidKey.trim()) { setNotice('Укажите ключ AcoustID.'); setNoticeKind('error'); return }
    if (!status?.settings.downloadDir) { setNotice('Выберите папку для аудио.'); setNoticeKind('error'); return }
    if (!status?.tools.ytDlp.installed) { setNotice('Сначала установите инструменты (yt-dlp и fpcalc).'); setNoticeKind('error'); return }
    if (!status?.tools.fpcalc.installed) { setNotice('Сначала установите инструменты (yt-dlp и fpcalc).'); setNoticeKind('error'); return }
    setBusy(true)
    setNotice('')
    try {
      const job = await window.mustplay.startPipelineImport(url.trim())
      if (!mounted.current) return
      setActiveJob(job)
      setJobs(previous => [summarize(job), ...previous.filter(item => item.id !== job.id)])
      setNotice(`Импорт запущен: ${job.playlistName}`)
      setNoticeKind('ok')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Не удалось начать импорт.')
      setNoticeKind('error')
    } finally {
      if (mounted.current) setBusy(false)
    }
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

  const settings = status?.settings ?? emptySettings
  const tools = status?.tools ?? emptyTools
  const items = activeJob?.items ?? []

  return <section aria-label="Импорт из плейлистов">
    <header className="section-heading">
      <h1>Импорт музыки</h1>
      <p className="muted">Плейлист → метаданные → аудио → проверка отпечатком → локальная копия с логом по каждому треку.</p>
    </header>

    <section className="settings-card">
      <h2>Настройки импорта</h2>
      <div className="settings-option">
        <span>Ссылка на плейлист</span>
        <input className="settings-input" placeholder="https://open.spotify.com/playlist/… или deezer.com/playlist/…" value={url} onChange={event => setUrl(event.currentTarget.value)} />
      </div>
      <div className="settings-option">
        <span>Client ID Spotify</span>
        <input className="settings-input" placeholder="из developer.spotify.com" value={clientId}
          onChange={event => setClientId(event.currentTarget.value)}
          onBlur={() => void saveField('spotifyClientId', clientId)} />
        {settings.spotifyConnected && <span className="muted" style={{ marginLeft: 8 }}>подключён</span>}
      </div>
      <div className="settings-option">
        <span>Ключ AcoustID</span>
        <input className="settings-input" placeholder="из acoustid.org" value={acoustidKey}
          onChange={event => setAcoustidKey(event.currentTarget.value)}
          onBlur={() => void saveField('acoustidKey', acoustidKey)} />
      </div>
      <div className="settings-option">
        <span>Папка для аудио</span>
        <span className="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{settings.downloadDir || 'не выбрана'}</span>
        <button className="icon-button" onClick={chooseFolder} disabled={busy}>Выбрать папку</button>
      </div>
      <div className="settings-option">
        <span>Параллельных загрузок</span>
        <input type="number" className="settings-input" min={1} max={5} value={String(settings.workers)}
          onChange={event => void saveField('workers', Math.min(5, Math.max(1, Number(event.currentTarget.value) || 1)))} />
      </div>
    </section>

    <section className="settings-card">
      <h2>Spotify</h2>
      <p className="muted">Нужен бесплатный Client ID из Spotify for Developers. Redirect URI: <code>http://127.0.0.1:8888/callback</code>. Добавьте свой аккаунт в User Management.</p>
      <div className="settings-option">
        {settings.spotifyConnected
          ? <span>Аккаунт подключён.</span>
          : <button className="icon-button" onClick={connectSpotify} disabled={busy || awaitingSpotify}>
            {awaitingSpotify ? 'Ждём подтверждения…' : 'Подключить Spotify'}
          </button>}
        {settings.spotifyConnected && <button className="icon-button" onClick={disconnectSpotify} disabled={busy}>Отключить</button>}
      </div>
    </section>

    <section className="settings-card">
      <h2>Инструменты</h2>
      <div className="settings-option">
        <span>yt-dlp</span>
        <span className="muted" style={{ marginLeft: 8 }}>{tools.ytDlp.installed ? 'установлен' : tools.ytDlp.hint}</span>
      </div>
      <div className="settings-option">
        <span>fpcalc (Chromaprint)</span>
        <span className="muted" style={{ marginLeft: 8 }}>{tools.fpcalc.installed ? 'установлен' : tools.fpcalc.hint}</span>
      </div>
      <button className="icon-button" onClick={installTools} disabled={busy}>Установить инструменты</button>
    </section>

    <div className="library-tools">
      <button className="icon-button" onClick={startImport} disabled={busy || activeJob?.status === 'running'}>Начать импорт</button>
      {activeJob?.status === 'running' && <button className="icon-button" onClick={cancelImport}>Остановить</button>}
      {settings.downloadDir && <button className="icon-button" onClick={() => void window.mustplay.openPipelineFolder()}>Папка с аудио</button>}
    </div>

    {notice && <p className={`notice ${noticeKind === 'error' ? 'notice-error' : ''}`} role="alert">{notice}</p>}

    <h2>Задания ({jobs.length})</h2>
    <div className="list-pager">
      {jobs.map(summary => <button key={summary.id} className="settings-option" onClick={() => void openJob(summary.id)}
        style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: 6, width: '100%', background: summary.id === activeJob?.id ? 'var(--panel-hover, var(--panel))' : 'transparent', color: 'inherit', textAlign: 'left' }}>
        <strong>{summary.playlistName}</strong> ({pipelineProviderLabels[summary.provider]})
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>{summary.status}</span>
        <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--muted)' }}>{summary.verified} / {summary.total} подтверждено</span>
      </button>)}
      {jobs.length === 0 && <p className="muted">Заданий пока нет.</p>}
    </div>

    {activeJob && <section className="settings-card">
      <h2>{activeJob.playlistName} — лог треков</h2>
      <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--panel)' }}>
        {items.map(item => <div key={item.id} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13, lineHeight: 1.4 }}>
          <div style={{ width: 26, flexShrink: 0 }}>{item.position + 1}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
            <div style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.artist ?? '—'}{item.album ? ` · ${item.album}` : ''}{item.isrc ? ` · ISRC ${item.isrc}` : ''}</div>
          </div>
          <div style={{ width: 170, textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontWeight: 600, color: item.status === 'verified' ? 'var(--success, #4caf50)' : item.status === 'rejected' ? 'var(--error, #f44336)' : 'var(--muted)' }}>{item.status}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>{item.method}{item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ''}</div>
            <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filePath ?? item.message}</div>
          </div>
        </div>)}
        {items.length === 0 && <p style={{ color: 'var(--muted)', padding: 10 }}>Нет треков.</p>}
      </div>
      <p style={{ fontSize: 12, color: 'var(--muted)' }}>{activeJob.message ?? ''}</p>
    </section>}
  </section>
}
