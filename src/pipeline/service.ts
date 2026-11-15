import type {
  AcoustidRecording, AudioCandidate, PipelineDownloadFormat, PipelineItemStatus, PipelineJob, PipelineJobSummary,
  PipelineMethod, PipelineProvider, PipelineSettings, PipelineStatus,
  PipelineTools, PipelineTrackInput, ProviderPlaylist, WebSourceProvider,
} from '../shared/pipeline'
import { builtInAcoustidKey, pipelineProviderLabels, pipelineImportConcurrency, pipelineVerificationRate, pipelineMetadataRate, pipelineDeezerRate, pipelineSpotifyRate, pipelineWorkerLimits, webSourceProviders } from '../shared/pipeline'
import { LibraryStore } from '../main/library-store'
import { runTrack, runTracks } from './orchestrator'
import type { TrackDeps } from './orchestrator'
import { DeferredFingerprinter, AcoustidKeyError } from './fingerprint'
import type { AcoustidInput } from './fingerprint'
import { YtDlp } from '../audio/ytdlp'
import { DeezerProvider } from '../metadata/providers/deezer'
import { SpotifyEmbedProvider } from '../metadata/providers/spotify-embed'
import { SpotifyProvider, spotifyAuthorizationUrl, createCodeVerifier } from '../metadata/providers/spotify'
import { MusicBrainzLookup } from '../metadata/musicbrainz'
import { parsePlaylistUrl, stubProviders } from '../metadata/providers/types'
import { RateLimiter, retry } from './limiter'
import { ToolManager } from './tools'
import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

const defaultSettings: PipelineSettings = {
  spotifyClientId: '',
  acoustidKey: builtInAcoustidKey,
  downloadDir: '',
  workers: pipelineImportConcurrency,
  format: 'm4a',
  spotifyConnected: false,
}

function isInside(directory: string, path: string): boolean {
  const rel = relative(directory, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

export interface PipelineServiceHooks {
  /**
   * Called after an import finishes so the verified files become library
   * tracks and a playlist. Returns the playlist ID, if one was created.
   */
  importJob?: (job: PipelineJob, downloadDir: string) => Promise<string | null>
}

export class PipelineService {
  private readonly store: LibraryStore
  private readonly tools: ToolManager
  private readonly acoustidLimit: RateLimiter
  private readonly musicbrainzLimit: RateLimiter
  private readonly deezerLimit: RateLimiter
  private readonly spotifyLimit: RateLimiter
  private readonly jobs = new Map<string, PipelineJob>()
  private currentJobId: string | null = null
  private abortController: AbortController | null = null
  /** Set when the pipeline stops itself, e.g. because AcoustID rejected the key. */
  private abortReason: string | null = null
  private spotifyVerifier: string | null = null
  private spotifyState: string | null = null
  private spotifyToken: string | null = null

  private readonly deezer: DeezerProvider
  private readonly spotify: SpotifyProvider
  private readonly spotifyEmbed: SpotifyEmbedProvider
  private readonly musicbrainz: MusicBrainzLookup
  private readonly fingerprints: DeferredFingerprinter

  constructor(
    store: LibraryStore,
    tools: ToolManager,
    private readonly hooks: PipelineServiceHooks = {},
  ) {
    this.store = store
    this.tools = tools
    for (const job of this.store.loadPipelineJobs()) {
      // A job that was running when the app closed cannot continue.
      if (job.status === 'running') {
        job.status = 'cancelled'
        job.message = 'Приложение было закрыто до завершения импорта'
        job.finishedAt = job.finishedAt ?? new Date().toISOString()
        for (const item of job.items) {
          if (item.status === 'pending' || item.status === 'searching' ||
              item.status === 'downloading' || item.status === 'verifying') {
            item.status = 'skipped'
            item.message = 'Импорт остановлен'
          }
        }
        this.store.savePipelineJob(job)
      }
      this.jobs.set(job.id, job)
    }
    const msPerRequest = (seconds: number, requests: number) => (1000 * seconds) / requests
    this.acoustidLimit = new RateLimiter(msPerRequest(pipelineVerificationRate.perSeconds, pipelineVerificationRate.requests))
    this.musicbrainzLimit = new RateLimiter(msPerRequest(pipelineMetadataRate.perSeconds, pipelineMetadataRate.requests))
    this.deezerLimit = new RateLimiter(msPerRequest(pipelineDeezerRate.perSeconds, pipelineDeezerRate.requests))
    this.spotifyLimit = new RateLimiter(msPerRequest(pipelineSpotifyRate.perSeconds, pipelineSpotifyRate.requests))
    this.deezer = new DeezerProvider(this.deezerLimit, fetch)
    this.spotify = new SpotifyProvider(async () => this.spotifyToken ?? '', this.spotifyLimit, fetch)
    this.spotifyEmbed = new SpotifyEmbedProvider(fetch)
    this.musicbrainz = new MusicBrainzLookup(this.musicbrainzLimit, fetch)
    this.fingerprints = new DeferredFingerprinter(() => this.tools.binary('fpcalc'))
  }

  private ytdlp(): YtDlp | null {
    const binary = this.tools.binary('ytDlp')
    return binary ? new YtDlp(binary) : null
  }

  static defaultSettings(): PipelineSettings {
    return { ...defaultSettings }
  }

  status(settings: PipelineSettings, tools: PipelineTools): PipelineStatus {
    return { settings: { ...defaultSettings, ...settings }, tools, job: this.currentJob() ?? null }
  }

  currentJob(): PipelineJob | null {
    return this.currentJobId ? this.jobs.get(this.currentJobId) ?? null : null
  }

  private newJobId(): string {
    return crypto.randomUUID()
  }

  /** Downloads the two binaries on first use; the user does not configure anything. */
  async ensureTools(): Promise<PipelineTools> {
    const initial = await this.tools.status()
    if (initial.ytDlp.installed && initial.fpcalc.installed) return initial
    const installed = await this.tools.install()
    if (!installed.ytDlp.installed || !installed.fpcalc.installed) {
      const reasons = [installed.ytDlp, installed.fpcalc]
        .filter(tool => !tool.installed)
        .map(tool => tool.hint)
        .join(' ')
      throw new Error(`Не удалось установить инструменты импорта. ${reasons}`)
    }
    return installed
  }

  /** Validates everything that must be in place before any playlist is fetched. */
  private async readySettings(
    settings: PipelineSettings,
  ): Promise<{ downloadDir: string; acoustidKey: string; format: PipelineDownloadFormat }> {
    if (this.currentJob()?.status === 'running') throw new Error('Импорт уже запущен')
    const downloadDir = settings.downloadDir
    if (!downloadDir) throw new Error('Не удалось определить папку для скачивания')
    const acoustidKey = settings.acoustidKey.trim() || builtInAcoustidKey
    if (!acoustidKey) throw new Error('Укажите ключ AcoustID в дополнительных настройках импорта')
    await this.ensureTools()
    const format: PipelineDownloadFormat = settings.format === 'original' ? 'original' : 'm4a'
    return { downloadDir, acoustidKey, format }
  }

  async startPipelineImport(url: string, settings: PipelineSettings, workers: number): Promise<PipelineJob> {
    const ref = parsePlaylistUrl(url)
    if (!ref) throw new Error('Неизвестная ссылка плейлиста')

    let playlist: ProviderPlaylist
    let sourceNote: string | null = null
    if (ref.provider === 'ytmusic') {
      throw new Error('YT Music импортируется через веб-сессию: нажмите «Открыть YT Music» и войдите в свой аккаунт')
    }
    if (stubProviders.has(ref.provider)) {
      if ((webSourceProviders as readonly string[]).includes(ref.provider)) {
        const label = pipelineProviderLabels[ref.provider]
        throw new Error(`${label} импортируется через веб-сессию: нажмите «${label}» в блоке сервисов и войдите в свой аккаунт`)
      }
      throw new Error(`Платформа ${pipelineProviderLabels[ref.provider]} не поддерживается: нужен платный аккаунт`)
    }
    const ready = await this.readySettings(settings)
    if (ref.provider === 'deezer') {
      playlist = await this.deezer.fetchPlaylist(ref.id)
    } else if (ref.provider === 'spotify') {
      if (this.spotifyToken) {
        playlist = await this.spotify.fetchPlaylist(ref.id)
        sourceNote = 'Spotify Web API'
      } else {
        // The embed page needs no account, but caps at 100 tracks and has no ISRC.
        playlist = await this.spotifyEmbed.fetchPlaylist(ref.id)
        sourceNote = playlist.note ?? 'Публичная страница Spotify'
      }
    } else {
      throw new Error(`Платформа ${pipelineProviderLabels[ref.provider]} не поддерживается`)
    }
    return this.startJob(ref.provider, ref.url, playlist, sourceNote, ready, workers)
  }

  /** Starts an import from a track list read inside the user's own web session. */
  async startWebSourceImport(
    input: { provider: WebSourceProvider; url: string; playlist: ProviderPlaylist },
    settings: PipelineSettings,
    workers: number,
  ): Promise<PipelineJob> {
    if (!(webSourceProviders as readonly string[]).includes(input.provider)) {
      throw new Error('Неизвестный веб-источник')
    }
    if (!input.playlist.tracks.length) throw new Error('В плейлисте нет треков')
    const ready = await this.readySettings(settings)
    return this.startJob(
      input.provider, input.url, input.playlist,
      input.playlist.note ?? 'Список прочитан из вашей веб-сессии', ready, workers,
    )
  }

  private startJob(
    provider: PipelineProvider,
    playlistUrl: string,
    playlist: ProviderPlaylist,
    sourceNote: string | null,
    settings: { downloadDir: string; acoustidKey: string; format: PipelineDownloadFormat },
    workers: number,
  ): PipelineJob {
    if (this.currentJob()?.status === 'running') throw new Error('Импорт уже запущен')
    if (!playlist.tracks.length) throw new Error('В плейлисте нет треков')
    const job: PipelineJob = {
      id: this.newJobId(),
      provider,
      playlistUrl,
      playlistName: playlist.name,
      status: 'running',
      total: playlist.tracks.length,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      sourceNote: sourceNote ?? playlist.note ?? null,
      playlistId: null,
      items: playlist.tracks.map((track, index) => ({
        id: crypto.randomUUID(),
        position: index,
        title: track.title,
        artist: track.artist,
        album: track.album,
        genres: track.genres ?? [],
        durationSeconds: track.durationSeconds,
        isrc: track.isrc,
        status: 'pending' as PipelineItemStatus,
        method: 'none' as PipelineMethod,
        confidence: null,
        filePath: null,
        message: track.sourceUrl ? 'Прямая ссылка на запись' : 'В очереди',
        candidateId: null,
        cached: false,
        updatedAt: new Date().toISOString(),
      })),
    }
    this.jobs.set(job.id, job)
    this.currentJobId = job.id
    this.abortController = new AbortController()
    this.abortReason = null
    this.persist(job)

    void this.runJob(job, playlist.tracks, settings, workers)
    return job
  }

  private persist(job: PipelineJob): void {
    try {
      this.store.savePipelineJob(job)
    } catch {
      // Losing history must never break an import that is already running.
    }
  }

  private async runJob(
    job: PipelineJob,
    tracks: readonly PipelineTrackInput[],
    settings: { downloadDir: string; acoustidKey: string; format: PipelineDownloadFormat },
    workers: number,
  ): Promise<void> {
    const signal = this.abortController?.signal
    let verified = 0
    let failed = 0
    let processed = 0

    try {
      await runTracks(tracks, (track, index) => this.depsFor(track, index, job.id, settings, signal), workers,
        async (_track, outcome, index) => {
          const item = job.items[index]
          if (!item) return
          item.status = outcome.status
          item.method = outcome.method
          item.confidence = outcome.confidence
          item.filePath = outcome.filePath
          item.message = outcome.message
          item.candidateId = outcome.candidateId
          item.cached = outcome.cached
          item.updatedAt = new Date().toISOString()
          if (outcome.status !== 'skipped') {
            processed++
            if (outcome.status === 'verified') verified++
            else failed++
          }
          job.message = `Обработано ${processed} из ${job.total} (подтверждено ${verified}, отброшено ${failed})`
          this.persist(job)
        })
    } catch (error) {
      job.status = 'failed'
      job.message = error instanceof Error ? error.message : 'Импорт прерван'
      job.finishedAt = new Date().toISOString()
      this.persist(job)
      return
    } finally {
      this.abortController = null
    }

    job.finishedAt = new Date().toISOString()
    if (this.abortReason) {
      job.status = 'failed'
      job.message = `${this.abortReason}. Импорт остановлен: подтверждено ${verified} из ${job.total}.`
    } else if (signal?.aborted) {
      job.status = 'cancelled'
      job.message = `Остановлено. Подтверждено ${verified} из ${job.total}.`
    } else {
      job.status = 'done'
      job.message = `Завершено. Подтверждено ${verified} из ${job.total}, отброшено ${failed}.`
    }
    if (this.abortReason || signal?.aborted) {
      // Tracks that never started would otherwise stay "pending" forever.
      for (const item of job.items) {
        if (item.status === 'pending' || item.status === 'searching' ||
            item.status === 'downloading' || item.status === 'verifying') {
          item.status = 'skipped'
          item.message = 'Импорт остановлен'
          item.updatedAt = new Date().toISOString()
        }
      }
    }
    if (job.status === 'done' && this.hooks.importJob) {
      try {
        job.playlistId = await this.hooks.importJob(job, settings.downloadDir)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        job.message = `${job.message} Не удалось добавить треки в библиотеку: ${reason}`
      }
    }
    this.persist(job)
  }

  private depsFor(
    track: PipelineTrackInput,
    index: number,
    jobId: string,
    settings: { downloadDir: string; acoustidKey: string; format: PipelineDownloadFormat },
    signal: AbortSignal | undefined,
    options: { excludedCandidates?: ReadonlySet<string>; useCache?: boolean } = {},
  ): TrackDeps {
    const update = (status: PipelineItemStatus) => {
      const item = this.jobs.get(jobId)?.items[index]
      if (item) item.status = status
    }
    const isCancelled = () => signal?.aborted === true || this.currentJobId !== jobId

    const cachedFile = async (isrc: string): Promise<string | null> => {
      const cached = this.store.getCachedFileByIsrc(isrc)
      return cached && existsSync(cached) && isInside(settings.downloadDir, cached) ? cached : null
    }

    const resolveIsrc = async (isrc: string): Promise<PipelineTrackInput | null> => {
      try {
        const fromDeezer = await retry(() => this.deezer.resolveIsrc(isrc), 2, 600)
        if (fromDeezer) return fromDeezer
        return await retry(() => this.musicbrainz.resolveIsrc(isrc), 2, 600)
      } catch {
        return null
      }
    }

    const resolveTrack = async (t: PipelineTrackInput): Promise<PipelineTrackInput | null> => {
      try {
        const fromDeezer = await retry(() => this.deezer.searchTrack(t), 2, 600)
        if (fromDeezer?.isrc) return fromDeezer
      } catch {
        // MusicBrainz stays the fallback when Deezer is unavailable.
      }
      try {
        return await retry(() => this.musicbrainz.searchTrack(t), 2, 600)
      } catch {
        return null
      }
    }

    const search = async (t: PipelineTrackInput): Promise<AudioCandidate[]> => {
      const ytdlp = this.ytdlp()
      if (!ytdlp) throw new Error('yt-dlp не установлен')
      const candidates: AudioCandidate[] = await retry(() => ytdlp.search(t, signal), 2, 1000)
      return candidates.slice(0, 5)
    }

    const download = async (candidate: AudioCandidate): Promise<string> => {
      const ytdlp = this.ytdlp()
      if (!ytdlp) throw new Error('yt-dlp не установлен')
      return await ytdlp.download(candidate, settings.downloadDir, signal, settings.format)
    }

    const fingerprint = async (path: string) => {
      const fp = await (await this.fingerprints.get()).fingerprint(path)
      return { durationSeconds: fp.durationSeconds, fingerprint: fp.fingerprint }
    }

    const lookupAcoustid = async (input: AcoustidInput): Promise<AcoustidRecording[]> => {
      const lookup = async () => {
        const fingerprinter = await this.fingerprints.get()
        return this.acoustidLimit.run(() => fingerprinter.lookup(settings.acoustidKey, input))
      }
      try {
        // A rejected key is permanent, so it must not be retried.
        return await retry(lookup, 2, 1000, error => !(error instanceof AcoustidKeyError))
      } catch (error) {
        if (error instanceof AcoustidKeyError && !this.abortReason) {
          // Every remaining track would fail the same way: stop the whole import.
          this.abortReason = error.message
          this.abortController?.abort()
        }
        throw error
      }
    }

    const remember = async (t: PipelineTrackInput, filePath: string, verdict: { method: PipelineMethod; confidence: number; message: string }, fp: AcoustidInput) => {
      const isrc = t.isrc
      if (isrc) {
        this.store.recordIsrcFile(isrc, null, filePath, t.providerId ?? 'pipeline')
        this.store.recordFingerprint(fp.fingerprint, isrc)
      }
      const item = this.jobs.get(jobId)?.items[index]
      if (item) {
        item.method = verdict.method
        item.confidence = verdict.confidence
      }
    }

    const discard = async (filePath: string) => {
      const { unlink } = await import('node:fs/promises')
      await unlink(filePath).catch(() => {})
    }

    return {
      cachedFile, resolveIsrc, resolveTrack, search, download, fingerprint, lookupAcoustid, remember, discard, update, isCancelled,
      excludedCandidates: options.excludedCandidates,
      useCache: options.useCache,
    }
  }

  async cancelPipelineImport(): Promise<void> {
    this.abortController?.abort()
    const job = this.currentJob()
    if (job && job.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.message = 'Остановлено пользователем'
      this.persist(job)
    }
    this.abortController = null
  }

  getPipelineJob(id: string): PipelineJob | null {
    return this.jobs.get(id) ?? null
  }

  listPipelineJobs(): PipelineJobSummary[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(job => ({
        id: job.id, provider: job.provider, playlistName: job.playlistName, status: job.status,
        total: job.total, verified: job.items.filter(i => i.status === 'verified').length,
        createdAt: job.createdAt, playlistId: job.playlistId,
      }))
  }

  /** Marks a rejected track as intentionally left out, without chasing versions. */
  skipPipelineItem(jobId: string, itemId: string): PipelineJob {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Задание не найдено')
    const item = job.items.find(entry => entry.id === itemId)
    if (!item) throw new Error('Трек не найден в задании')
    item.status = 'skipped'
    item.message = 'Пропущено пользователем'
    item.updatedAt = new Date().toISOString()
    this.persist(job)
    return job
  }

  /** Retries one track of a finished job, either with the next download
   * candidate («Другая версия») or the same one again («Повторить»).
   * The job stays the same, so its history and playlist links remain valid.
   */
  async retryPipelineItem(
    jobId: string,
    itemId: string,
    settings: PipelineSettings,
    workers: number,
  ): Promise<PipelineJob> {
    if (this.currentJob()?.status === 'running') throw new Error('Импорт уже запущен')
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('Задание не найдено')
    const item = job.items.find(entry => entry.id === itemId)
    if (!item) throw new Error('Трек не найден в задании')
    const ready = await this.readySettings(settings)
    if (workers < pipelineWorkerLimits.min) throw new Error('Некорректное число загрузок')

    const track: PipelineTrackInput = {
      title: item.title,
      artist: item.artist,
      album: item.album,
      durationSeconds: item.durationSeconds,
      isrc: item.isrc,
      genres: item.genres,
      providerId: null,
    }
    const excluded = new Set<string>(item.candidateId ? [item.candidateId] : [])
    this.currentJobId = job.id
    this.abortController = new AbortController()
    this.abortReason = null
    item.status = 'pending'
    item.message = 'Повторяем'
    item.updatedAt = new Date().toISOString()
    job.status = 'running'
    job.finishedAt = null
    this.persist(job)

    try {
      const index = job.items.indexOf(item)
      const outcome = await runTrack(track, this.depsFor(track, index, job.id, ready, this.abortController.signal, {
        excludedCandidates: excluded,
        useCache: false,
      }))
      item.status = outcome.status
      item.method = outcome.method
      item.confidence = outcome.confidence
      item.filePath = outcome.filePath
      item.message = outcome.message
      item.candidateId = outcome.candidateId ?? item.candidateId
      item.cached = outcome.cached
      item.updatedAt = new Date().toISOString()
    } catch (error) {
      item.status = 'failed'
      item.message = error instanceof Error ? error.message : 'Повтор не удался'
      item.updatedAt = new Date().toISOString()
    } finally {
      this.abortController = null
      this.abortReason = null
    }

    const unfinished = job.items.some(entry =>
      entry.status === 'pending' || entry.status === 'searching' ||
      entry.status === 'downloading' || entry.status === 'verifying')
    const confirmed = job.items.filter(entry => entry.status === 'verified').length
    job.status = unfinished ? 'running' : 'done'
    job.finishedAt = unfinished ? null : new Date().toISOString()
    job.message = `Подтверждено ${confirmed} из ${job.total}.`
    if (!unfinished && this.hooks.importJob) {
      try {
        job.playlistId = await this.hooks.importJob(job, ready.downloadDir) ?? job.playlistId
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        job.message = `${job.message} Не удалось добавить трек в библиотеку: ${reason}`
      }
    }
    this.persist(job)
    return job
  }

  spotifyConnectUrl(clientId: string): { url: string; state: string } {
    this.spotifyVerifier = createCodeVerifier()
    this.spotifyState = crypto.randomUUID()
    return { url: spotifyAuthorizationUrl(clientId, this.spotifyVerifier, this.spotifyState), state: this.spotifyState }
  }

  async spotifyExchangeCode(clientId: string, code: string, state: string): Promise<boolean> {
    if (!this.spotifyState || this.spotifyState !== state) return false
    const verifier = this.spotifyVerifier
    if (!verifier) return false
    try {
      const body = new URLSearchParams()
      body.set('grant_type', 'authorization_code')
      body.set('code', code)
      body.set('redirect_uri', 'http://127.0.0.1:8888/callback')
      body.set('code_verifier', verifier)
      body.set('client_id', clientId)
      const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
      if (!response.ok) return false
      const payload = await response.json() as { access_token?: string }
      return !!payload.access_token && ((this.spotifyToken = payload.access_token), true)
    } catch {
      return false
    }
  }

  spotifyDisconnect(): void {
    this.spotifyToken = null
    this.spotifyVerifier = null
    this.spotifyState = null
  }

  async toolsStatus(): Promise<PipelineTools> {
    return this.tools.status()
  }

  async installTools(): Promise<PipelineTools> {
    return this.tools.install()
  }

  async openDownloadFolder(downloadDir: string): Promise<void> {
    await shell.openPath(downloadDir)
  }
}

export { defaultSettings }
