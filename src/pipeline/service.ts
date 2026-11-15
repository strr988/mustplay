import type {
  AcoustidRecording, AudioCandidate, PipelineItemStatus, PipelineJob, PipelineJobStatus,
  PipelineMethod, PipelineProvider, PipelineSettings, PipelineStatus,
  PipelineTools, PipelineTrackInput, ProviderPlaylist,
} from '../shared/pipeline'
import { pipelineProviderLabels, pipelineImportConcurrency, pipelineVerificationRate, pipelineMetadataRate, pipelineDeezerRate, pipelineSpotifyRate } from '../shared/pipeline'
import { LibraryStore } from '../main/library-store'
import { runTracks } from './orchestrator'
import type { TrackDeps, TrackOutcome } from './orchestrator'
import { DeferredFingerprinter } from './fingerprint'
import type { AcoustidInput } from './fingerprint'
import { YtDlp } from '../audio/ytdlp'
import { DeezerProvider } from '../metadata/providers/deezer'
import { SpotifyProvider, spotifyAuthorizationUrl, createCodeVerifier } from '../metadata/providers/spotify'
import { MusicBrainzLookup } from '../metadata/musicbrainz'
import { parsePlaylistUrl, stubProviders } from '../metadata/providers/types'
import { RateLimiter, retry } from './limiter'
import { ToolManager } from './tools'
import { shell } from 'electron'
import { existsSync } from 'node:fs'

const defaultSettings: PipelineSettings = {
  spotifyClientId: '',
  acoustidKey: '',
  downloadDir: '',
  workers: pipelineImportConcurrency,
  spotifyConnected: false,
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
  private spotifyVerifier: string | null = null
  private spotifyState: string | null = null
  private spotifyToken: string | null = null

  private readonly deezer: DeezerProvider
  private readonly spotify: SpotifyProvider
  private readonly musicbrainz: MusicBrainzLookup
  private readonly fingerprints: DeferredFingerprinter

  constructor(
    store: LibraryStore,
    tools: ToolManager,
  ) {
    this.store = store
    this.tools = tools
    const msPerRequest = (seconds: number, requests: number) => (1000 * seconds) / requests
    this.acoustidLimit = new RateLimiter(msPerRequest(pipelineVerificationRate.perSeconds, pipelineVerificationRate.requests))
    this.musicbrainzLimit = new RateLimiter(msPerRequest(pipelineMetadataRate.perSeconds, pipelineMetadataRate.requests))
    this.deezerLimit = new RateLimiter(msPerRequest(pipelineDeezerRate.perSeconds, pipelineDeezerRate.requests))
    this.spotifyLimit = new RateLimiter(msPerRequest(pipelineSpotifyRate.perSeconds, pipelineSpotifyRate.requests))
    this.deezer = new DeezerProvider(this.deezerLimit, fetch)
    this.spotify = new SpotifyProvider(async () => this.spotifyToken ?? '', this.spotifyLimit, fetch)
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

  async startPipelineImport(url: string, settings: PipelineSettings, workers: number): Promise<PipelineJob> {
    if (this.currentJob()?.status === 'running') throw new Error('Импорт уже запущен')
    const ref = parsePlaylistUrl(url)
    if (!ref) throw new Error('Неизвестная ссылка плейлиста')
    const downloadDir = settings.downloadDir
    if (!downloadDir) throw new Error('Укажите папку для скачивания в настройках импорта')
    const acoustidClient = settings.acoustidKey
    if (!acoustidClient) throw new Error('Укажите ключ AcoustID в настройках импорта')
    const tools = await this.tools.status()
    if (!tools.ytDlp.installed) throw new Error(tools.ytDlp.hint)
    if (!tools.fpcalc.installed) throw new Error(tools.fpcalc.hint)

    let playlist: ProviderPlaylist
    if (stubProviders.has(ref.provider)) {
      throw new Error(`Платформа ${pipelineProviderLabels[ref.provider]} ещё не реализована`)
    }
    if (ref.provider === 'deezer') {
      playlist = await this.deezer.fetchPlaylist(ref.id)
    } else if (ref.provider === 'spotify') {
      if (!this.spotifyToken) throw new Error('Подключите Spotify в настройках импорта')
      playlist = await this.spotify.fetchPlaylist(ref.id)
    } else {
      throw new Error(`Платформа ${pipelineProviderLabels[ref.provider]} не поддерживается`)
    }
    if (!playlist.tracks.length) throw new Error('В плейлисте нет треков')

    const job: PipelineJob = {
      id: this.newJobId(),
      provider: ref.provider,
      playlistUrl: ref.url,
      playlistName: playlist.name,
      status: 'running',
      total: playlist.tracks.length,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      message: null,
      items: playlist.tracks.map((track, index) => ({
        id: crypto.randomUUID(),
        position: index,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationSeconds: track.durationSeconds,
        isrc: track.isrc,
        status: 'pending' as PipelineItemStatus,
        method: 'none' as PipelineMethod,
        confidence: null,
        filePath: null,
        message: 'В очереди',
        updatedAt: new Date().toISOString(),
      })),
    }
    this.jobs.set(job.id, job)
    this.currentJobId = job.id
    this.abortController = new AbortController()

    void this.runJob(job, playlist.tracks, { ...settings, downloadDir, acoustidKey: acoustidClient }, workers)
    return job
  }

  private async runJob(
    job: PipelineJob,
    tracks: readonly PipelineTrackInput[],
    settings: PipelineSettings & { downloadDir: string; acoustidKey: string },
    workers: number,
  ): Promise<void> {
    const signal = this.abortController?.signal
    let verified = 0
    let failed = 0
    let processed = 0

    try {
      await runTracks(tracks, (track, index) => this.depsFor(track, index, job.id, settings, signal), workers,
        async (_track, outcome, index) => {
          if (signal?.aborted) return
          const item = job.items[index]
          if (!item) return
          item.status = outcome.status
          item.method = outcome.method
          item.confidence = outcome.confidence
          item.filePath = outcome.filePath
          item.message = outcome.message
          item.updatedAt = new Date().toISOString()
          processed++
          if (outcome.status === 'verified') verified++
          else if (outcome.status === 'failed' || outcome.status === 'rejected') failed++
          job.message = `Обработано ${processed} из ${job.total} (подтверждено ${verified}, отброшено ${failed})`
        })
    } catch (error) {
      job.status = 'failed'
      job.message = error instanceof Error ? error.message : 'Импорт прерван'
      job.finishedAt = new Date().toISOString()
      return
    } finally {
      this.abortController = null
    }

    job.status = signal?.aborted ? 'cancelled' : 'done'
    job.finishedAt = new Date().toISOString()
    job.message = signal?.aborted
      ? `Остановлено. Подтверждено ${verified} из ${job.total}.`
      : `Завершено. Подтверждено ${verified} из ${job.total}, отброшено ${failed}.`
  }

  private depsFor(
    track: PipelineTrackInput,
    index: number,
    jobId: string,
    settings: PipelineSettings & { downloadDir: string; acoustidKey: string },
    signal: AbortSignal | undefined,
  ): TrackDeps {
    const update = (status: PipelineItemStatus) => {
      const item = this.jobs.get(jobId)?.items[index]
      if (item) item.status = status
    }
    const isCancelled = () => signal?.aborted === true || this.currentJobId !== jobId

    const cachedFile = async (isrc: string): Promise<string | null> => {
      const cached = this.store.getCachedFileByIsrc(isrc)
      return cached && existsSync(cached) ? cached : null
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

    const search = async (t: PipelineTrackInput): Promise<AudioCandidate[]> => {
      const ytdlp = this.ytdlp()
      if (!ytdlp) throw new Error('yt-dlp не установлен')
      const candidates: AudioCandidate[] = await retry(() => ytdlp.search(t, signal), 2, 1000)
      return candidates.slice(0, 5)
    }

    const download = async (candidate: AudioCandidate): Promise<string> => {
      const ytdlp = this.ytdlp()
      if (!ytdlp) throw new Error('yt-dlp не установлен')
      return await ytdlp.download(candidate, settings.downloadDir, signal)
    }

    const fingerprint = async (path: string) => {
      const fp = await (await this.fingerprints.get()).fingerprint(path)
      return { durationSeconds: fp.durationSeconds, fingerprint: fp.fingerprint }
    }

    const lookupAcoustid = async (input: AcoustidInput): Promise<AcoustidRecording[]> => {
      return retry(async () => {
        const fingerprinter = await this.fingerprints.get()
        return this.acoustidLimit.run(() => fingerprinter.lookup(settings.acoustidKey, input))
      }, 2, 1000)
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

    return { cachedFile, resolveIsrc, search, download, fingerprint, lookupAcoustid, remember, discard, update, isCancelled }
  }

  async cancelPipelineImport(): Promise<void> {
    this.abortController?.abort()
    const job = this.currentJob()
    if (job && job.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.message = 'Остановлено пользователем'
    }
    this.abortController = null
  }

  getPipelineJob(id: string): PipelineJob | null {
    return this.jobs.get(id) ?? null
  }

  listPipelineJobs(): { id: string; provider: PipelineProvider; playlistName: string; status: PipelineJobStatus; total: number; verified: number; createdAt: string }[] {
    return Array.from(this.jobs.values()).map(job => ({
      id: job.id, provider: job.provider, playlistName: job.playlistName, status: job.status,
      total: job.total, verified: job.items.filter(i => i.status === 'verified').length, createdAt: job.createdAt,
    }))
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
