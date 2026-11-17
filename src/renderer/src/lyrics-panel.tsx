import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { LibraryTrack, Lyrics, LyricLine } from '../../shared/contracts'
import { activeLyric } from './active-lyric'
import { Artwork } from './artwork'
import { EmptyState } from './empty-state'
import { IconButton } from './icons'

export type LyricsResult = { lyrics: Lyrics | null } | 'error' | undefined

export function useTrackLyrics(track: LibraryTrack | undefined, enabled: boolean): LyricsResult {
  const trackId = track?.id
  const available = track?.available
  const artworkUrl = track?.artworkUrl
  const [state, setState] = useState<{ trackId: string; artworkUrl: string | null | undefined; result: LyricsResult }>()
  useEffect(() => {
    if (!enabled || !trackId || !available) return
    let current = true
    function finish(result: LyricsResult) {
      if (current && trackId) setState({ trackId, artworkUrl, result })
    }
    void window.mustplay.getLyrics(trackId).then(lyrics => finish({ lyrics })).catch(() => finish('error'))
    return () => { current = false }
  }, [enabled, trackId, available, artworkUrl])
  return available && state?.trackId === trackId && state?.artworkUrl === artworkUrl ? state?.result : undefined
}

export function LyricsDrawer({ track, result, close, closeButton, openTextMusic }: {
  track: LibraryTrack | undefined
  result: LyricsResult
  close(): void
  closeButton: RefObject<HTMLButtonElement | null>
  openTextMusic(): void
}) {
  return <aside id="song-lyrics" className="lyrics-drawer" aria-labelledby="song-lyrics-heading">
    <header className="queue-heading">
      <h2 id="song-lyrics-heading">Текст песни</h2>
      <IconButton ref={closeButton} icon="close" label="Закрыть текст песни" onClick={close} />
    </header>
    <div className="queue-body lyrics-drawer-body" key={track?.id} tabIndex={0}>
      {track && <div className="lyrics-track">
        <Artwork key={track.artworkUrl} url={track.artworkUrl} eager />
        <div className="min-w-0">
          <p className="track-name truncate" title={track.title}>{track.title}</p>
          {track.artist && <p className="muted truncate" title={track.artist}>{track.artist}</p>}
        </div>
      </div>}
      <LyricsPanel track={track} result={result} mode="read" />
    </div>
    {track && <div className="lyrics-drawer-actions">
      <button type="button" className="secondary" onClick={openTextMusic}>Открыть текстомузыку</button>
    </div>}
  </aside>
}

type LyricsPresentation = { mode: 'read' } | {
  mode: 'sync'
  audio: RefObject<HTMLAudioElement | null>
  active: boolean
  canSeek: boolean
  seek: (seconds: number) => void
}

export function LyricsPanel({ track, result, ...presentation }: {
  track: LibraryTrack | undefined
  result: LyricsResult
} & LyricsPresentation) {
  const mode = presentation.mode
  const lyrics = result && result !== 'error' ? result.lyrics : null
  let body
  if (!track) {
    body = <EmptyState icon="lyrics" title="Трек не выбран">Запустите трек из библиотеки, плейлиста или «Моей волны».</EmptyState>
  } else if (!track.available || (result && result !== 'error' && !result.lyrics)) {
    body = <EmptyState icon="lyrics" title="Текст не найден">Добавьте LRC или TXT с именем трека рядом с аудиофайлом.</EmptyState>
  } else if (result === 'error') {
    body = <p role="alert">Не удалось прочитать текст песни.</p>
  } else if (!result) {
    body = <p className="muted" role="status">Читаем текст…</p>
  } else if (lyrics?.kind === 'timed' && presentation.mode === 'sync') {
    body = <TimedLyrics lines={lyrics.lines} active={presentation.active} audio={presentation.audio}
      canSeek={presentation.canSeek} seek={presentation.seek} />
  } else if (lyrics) {
    const text = lyrics.kind === 'plain' ? lyrics.text : lyrics.lines.map(line => line.text).join('\n').trim()
    body = <>
      {mode === 'sync' && <p className="lyrics-note muted">У этого текста нет временных меток.</p>}
      <div className="lyrics-plain" tabIndex={mode === 'sync' ? 0 : undefined}>{text}</div>
    </>
  }
  if (mode === 'read') return body
  return <section id="full-player-lyrics" aria-labelledby="full-lyrics-heading" className="text-music">
    <h2 id="full-lyrics-heading">Текстомузыка</h2>
    {body}
  </section>
}

function TimedLyrics({ lines, active, audio, canSeek, seek }: {
  lines: LyricLine[]
  active: boolean
  audio: RefObject<HTMLAudioElement | null>
  canSeek: boolean
  seek: (seconds: number) => void
}) {
  const [current, setCurrent] = useState(-1)
  const [follow, setFollow] = useState(true)
  const currentLine = useRef<HTMLLIElement>(null)
  const list = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const element = audio.current
    if (!active || !element) return
    const update = () => setCurrent(element.hasAttribute('src') ? activeLyric(lines, element.currentTime) : -1)
    update()
    const events = ['timeupdate', 'seeking', 'emptied'] as const
    for (const event of events) element.addEventListener(event, update)
    return () => { for (const event of events) element.removeEventListener(event, update) }
  }, [active, audio, lines])
  useEffect(() => {
    if (!active || !follow) return
    const line = currentLine.current
    const scroller = list.current
    if (!scroller) return
    const top = line ? scroller.scrollTop + line.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top + (line.offsetHeight - scroller.clientHeight) / 2 : 0
    scroller.scrollTo({
      top,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  }, [current, follow, active])

  return <>
    <div className="lyrics-toolbar">
      <button type="button" className="secondary" aria-pressed={follow} onClick={() => setFollow(!follow)}>
        Следить за текстом
      </button>
    </div>
    <ol ref={list} className="lyrics-lines" aria-label="Строки текста" onWheel={() => setFollow(false)}
      onTouchMove={() => setFollow(false)} onKeyDown={event => {
        if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) setFollow(false)
      }} onPointerDown={event => {
        if (event.target === event.currentTarget) setFollow(false)
      }} tabIndex={0}>
      {lines.map(({ seconds, text }, index) => <li key={index} ref={index === current ? currentLine : undefined}>
        {text && <button type="button" disabled={!canSeek} aria-current={index === current ? 'true' : undefined}
          data-past={index < current} onClick={() => { seek(seconds); setFollow(true) }}>{text}</button>}
      </li>)}
    </ol>
  </>
}
