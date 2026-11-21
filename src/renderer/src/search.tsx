import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { YandexDownload, YandexSearchResult, YandexSettings, YandexTrack } from '../../shared/contracts'
import { Artwork } from './artwork'
import { EmptyState } from './empty-state'
import { Icon, IconButton } from './icons'
import { formatTime } from './playback'

const statusLabels: Record<YandexDownload['status'], string> = {
  queued: 'В очереди', downloading: 'Загрузка', tagging: 'Теги', complete: 'Готово', error: 'Ошибка', cancelled: 'Отменено',
}
const activeStatuses = new Set<YandexDownload['status']>(['queued', 'downloading', 'tagging'])

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; query: string; page: number }
  | { status: 'done'; query: string; result: YandexSearchResult }
  | { status: 'error'; query: string; message: string }

export function Search({ active, openSettings }: {
  active: boolean
  openSettings: (target: 'sources' | 'files') => void
}) {
  const [settings, setSettings] = useState<YandexSettings | null>(null)
  const [settingsError, setSettingsError] = useState(false)
  const [downloads, setDownloads] = useState<YandexDownload[]>([])
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [actionError, setActionError] = useState('')
  const searchRevision = useRef(0)

  useEffect(() => {
    if (!active) return
    let current = true
    void window.mustplay.getYandexSettings().then(value => {
      if (current) { setSettings(value); setSettingsError(false) }
    }).catch(() => { if (current) setSettingsError(true) })
    return () => { current = false }
  }, [active])

  useEffect(() => {
    let active = true
    void window.mustplay.getYandexDownloads().then(value => { if (active) setDownloads(value) }).catch(() => undefined)
    const unsubscribe = window.mustplay.onYandexDownloads(value => { if (active) setDownloads(value) })
    return () => { active = false; unsubscribe() }
  }, [])

  const latestByTrack = useMemo(() => {
    const map = new Map<string, YandexDownload>()
    for (const job of downloads) map.set(job.trackId, job)
    return map
  }, [downloads])

  const ready = !settingsError && !!settings?.hasToken
  const canDownload = ready && !!settings?.folderAvailable

  async function runSearch(text: string, page: number): Promise<void> {
    const revision = ++searchRevision.current
    setActionError('')
    setSearch({ status: 'loading', query: text, page })
    try {
      const result = await window.mustplay.yandexSearch(text, page)
      if (revision === searchRevision.current) setSearch({ status: 'done', query: text, result })
    } catch (error) {
      if (revision === searchRevision.current) setSearch({ status: 'error', query: text, message: errorMessage(error, 'Не удалось выполнить поиск.') })
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault()
    const text = query.trim()
    if (!text || !ready || search.status === 'loading') return
    void runSearch(text, 0)
  }

  async function download(track: YandexTrack): Promise<void> {
    setActionError('')
    try {
      await window.mustplay.yandexDownload(track.id)
    } catch (error) {
      setActionError(errorMessage(error, 'Не удалось начать загрузку.'))
      void window.mustplay.getYandexSettings().then(setSettings).catch(() => {})
    }
  }

  function cancel(id: string): void {
    void window.mustplay.yandexCancelDownload(id).catch(() => setActionError('Не удалось отменить загрузку.'))
  }

  const result = search.status === 'done' ? search.result : null
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.perPage)) : 1

  return <section aria-label="Поиск и загрузка Яндекс Музыки">
    <header className="section-heading">
      <div>
        <h1>Поиск</h1>
        <p className="muted">Найдите треки в Яндекс Музыке и сохраните их в свою папку.</p>
      </div>
    </header>
    <form className="yandex-search" onSubmit={submitSearch}>
      <label className="search-control">
        <Icon name="search" />
        <input type="search" aria-label="Поиск треков в Яндекс Музыке" placeholder="Название трека или исполнитель"
          value={query} onChange={event => setQuery(event.currentTarget.value)} disabled={!ready} />
      </label>
      <button type="submit" className="primary" disabled={!ready || !query.trim() || search.status === 'loading'}>
        <Icon name="search" />{search.status === 'loading' ? 'Ищем…' : 'Найти'}
      </button>
    </form>
    {settingsError && <p className="notice" role="alert">Не удалось загрузить параметры поиска.</p>}
    {!settings && !settingsError && <p className="muted" role="status">Проверяем подключение…</p>}
    {settings && !settingsError && (!ready || !canDownload) && <div className="settings-card service-notice">
      <p>{!ready ? 'Подключите Яндекс Музыку, чтобы искать треки.' : 'Папка загрузок недоступна.'}</p>
      <button type="button" className="secondary" onClick={() => openSettings(ready ? 'files' : 'sources')}>
        {!ready ? 'Подключить в настройках' : 'Выбрать папку в настройках'}
      </button>
    </div>}
    {actionError && <p className="notice" role="alert">{actionError}</p>}
    {search.status === 'loading' && <p className="notice" role="status">Ищем треки…</p>}
    {search.status === 'error' && <EmptyState icon="search" title="Поиск не удался"
      action={<div className="settings-actions">
        <button type="button" className="secondary" disabled={!ready} onClick={() => void runSearch(search.query, 0)}>Повторить</button>
        <button type="button" className="text-button" onClick={() => openSettings('sources')}>Настройки подключения</button>
      </div>}>
      {search.message}
    </EmptyState>}
    {ready && search.status === 'idle' && <EmptyState icon="search" title="Найдите музыку">
      Начните с названия трека или имени исполнителя.
    </EmptyState>}
    {result && (result.tracks.length === 0 ? <EmptyState icon="search" title="Треки не найдены">
      Попробуйте другой запрос.
    </EmptyState> : <div className="track-results">
      <nav className="list-pager" aria-label="Страницы поиска">
        <span className="muted" role="status">Страница {result.page + 1} из {totalPages} · найдено {result.total}</span>
        <IconButton icon="left" label="Предыдущая страница" aria-disabled={result.page === 0}
          onClick={() => { if (result.page > 0) void runSearch(search.status === 'done' ? search.query : query, result.page - 1) }} />
        <IconButton icon="right" label="Следующая страница" aria-disabled={result.page + 1 >= totalPages}
          onClick={() => { if (result.page + 1 < totalPages) void runSearch(search.status === 'done' ? search.query : query, result.page + 1) }} />
      </nav>
      <table className="tracks">
        <thead><tr>
          <th scope="col">Композиция</th>
          <th scope="col" className="album-column">Альбом</th>
          <th scope="col" className="time-column">Время</th>
          <th scope="col" className="actions-column">Загрузка</th>
        </tr></thead>
        <tbody>{result.tracks.map(track => <tr key={track.id}>
          <td><div className="track-button">
            <span className="track-cover"><Artwork url={track.coverUrl} /></span>
            <span className="track-text">
              <span className="track-name truncate">{track.title}</span>
              <span className="track-artist truncate" title={track.artist ?? undefined}>{track.artist ?? 'Неизвестный исполнитель'}</span>
            </span>
          </div></td>
          <td className="album-column truncate" title={track.album ?? undefined}>{track.album ?? '—'}</td>
          <td className="time-column">{formatTime(track.durationSeconds)}</td>
          <td><DownloadAction track={track} job={latestByTrack.get(track.id)} canDownload={canDownload}
            onDownload={() => void download(track)} onCancel={cancel} /></td>
        </tr>)}</tbody>
      </table>
    </div>)}
    <DownloadsPanel downloads={downloads} onCancel={cancel} onClear={() => {
      void window.mustplay.clearYandexHistory().catch(() => setActionError('Не удалось очистить историю загрузок.'))
    }} />
  </section>
}

function DownloadAction({ track, job, canDownload, onDownload, onCancel }: {
  track: YandexTrack
  job: YandexDownload | undefined
  canDownload: boolean
  onDownload: () => void
  onCancel: (id: string) => void
}) {
  if (!track.available) return <span className="muted">Недоступен</span>
  if (job && activeStatuses.has(job.status)) {
    return <div className="track-actions">
      <span className="muted yandex-progress">{statusLabels[job.status]}{job.status === 'downloading' ? ` ${Math.round(job.progress * 100)}%` : ''}</span>
      <IconButton icon="close" label={'Отменить загрузку: ' + track.title} onClick={() => onCancel(job.id)} />
    </div>
  }
  return <div className="track-actions">
    {job?.status === 'complete' && <span className="format yandex-done"><Icon name="check" />Готово</span>}
    {job?.status === 'error' && <span className="yandex-error" role="alert">
      {job.error ?? 'Не удалось скачать трек'}
    </span>}
    <IconButton icon="download" label={(job?.status === 'error' ? 'Повторить: ' : 'Скачать: ') + track.title}
      title={canDownload ? (job?.status === 'error' ? 'Повторить загрузку' : 'Скачать') : 'Проверьте подключение и папку загрузок в настройках'}
      disabled={!canDownload} onClick={onDownload} />
  </div>
}

function DownloadsPanel({ downloads, onCancel, onClear }: {
  downloads: YandexDownload[]
  onCancel: (id: string) => void
  onClear: () => void
}) {
  if (downloads.length === 0) return null
  const ordered = [...downloads].reverse()
  return <section className="settings-card yandex-downloads" aria-label="Загрузки Яндекс Музыки">
    <div className="settings-option">
      <h2>Загрузки</h2>
      <button type="button" className="secondary" disabled={downloads.every(job => activeStatuses.has(job.status))}
        onClick={onClear}>Очистить историю загрузок</button>
    </div>
    <p className="muted">Файлы сохраняются в выбранную папку. Добавьте её в библиотеку, чтобы слушать треки.</p>
    <ul>{ordered.map(job => <li key={job.id}>
      <div className="yandex-download-row">
        <div className="yandex-download-text">
          <span className="track-name truncate">{job.title || 'Трек ' + job.trackId}</span>
          {job.artist && <span className="track-artist truncate">{job.artist}</span>}
        </div>
        <div className="track-actions">
          <span className="format">{statusLabels[job.status]}</span>
          {job.status === 'downloading' && <span className="muted yandex-progress">{Math.round(job.progress * 100)}%</span>}
          {activeStatuses.has(job.status) && <IconButton icon="close" label={'Отменить: ' + (job.title || job.trackId)} onClick={() => onCancel(job.id)} />}
        </div>
      </div>
      {job.status === 'downloading' && <progress className="yandex-progress-bar" max={1} value={job.progress} aria-label="Прогресс загрузки" />}
      {job.status === 'error' && job.error && <p className="muted yandex-download-error" role="alert">{job.error}</p>}
    </li>)}</ul>
  </section>
}