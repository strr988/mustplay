export const pipelineProviders = ['deezer', 'spotify', 'apple', 'yandex', 'vk', 'soundcloud', 'ytmusic'] as const
export type PipelineProvider = typeof pipelineProviders[number]

export const pipelineProviderLabels: Record<PipelineProvider, string> = {
  deezer: 'Deezer',
  spotify: 'Spotify',
  apple: 'Apple Music',
  yandex: 'Яндекс Музыка',
  vk: 'ВК Музыка',
  soundcloud: 'SoundCloud',
  ytmusic: 'YT Music',
}

export interface PipelineTrackInput {
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number | null
  isrc: string | null
  genres?: string[]
  providerId: string | null
  /** Catalogue album ID, used to fetch the album's genres from Deezer. */
  albumProviderId?: string | null
  /** Exact audio URL when the source already knows the recording (YT Music). */
  sourceUrl?: string | null
}

export interface ProviderPlaylist {
  name: string
  tracks: PipelineTrackInput[]
  /** Human-readable caveat shown with the job, e.g. "public page returns 100 tracks". */
  note?: string | null
}

export type PipelineItemStatus =
  | 'pending' | 'searching' | 'downloading' | 'verifying'
  | 'verified' | 'rejected' | 'failed' | 'skipped'

export type PipelineMethod = 'isrc' | 'acoustid' | 'none'

export interface PipelineItem {
  id: string
  position: number
  title: string
  artist: string | null
  album: string | null
  genres: string[]
  durationSeconds: number | null
  isrc: string | null
  status: PipelineItemStatus
  method: PipelineMethod
  confidence: number | null
  filePath: string | null
  message: string | null
  /** The download that was tried, so a retry can skip it and use another one. */
  candidateId: string | null
  /** The file was already verified before and did not need another download. */
  cached: boolean
  updatedAt: string
}

export type PipelineJobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface PipelineJob {
  id: string
  provider: PipelineProvider
  playlistUrl: string
  playlistName: string
  status: PipelineJobStatus
  total: number
  createdAt: string
  finishedAt: string | null
  message: string | null
  /** How the track list was obtained, e.g. Spotify public page or YT Music session. */
  sourceNote: string | null
  /** Playlist created from the verified tracks, once the import has finished. */
  playlistId: string | null
  items: PipelineItem[]
}

export interface PipelineJobSummary {
  id: string
  provider: PipelineProvider
  playlistName: string
  status: PipelineJobStatus
  total: number
  verified: number
  createdAt: string
  playlistId: string | null
}

export type PipelineDownloadFormat = 'm4a' | 'original'

export interface PipelineSettings {
  spotifyClientId: string
  acoustidKey: string
  /**
   * Yandex Music OAuth token. It is a credential, so the renderer only ever
   * receives an empty string plus `PipelineStatus.yandexTokenSaved`.
   */
  yandexToken: string
  downloadDir: string
  workers: number
  format: PipelineDownloadFormat
  spotifyConnected: boolean
}

export type PipelineSettingsPatch = Partial<Omit<PipelineSettings, 'downloadDir' | 'spotifyConnected'>>

export interface PipelineToolState {
  name: string
  installed: boolean
  hint: string
}

export interface PipelineTools {
  ytDlp: PipelineToolState
  fpcalc: PipelineToolState
}

export interface PipelineStatus {
  settings: PipelineSettings
  /** Whether a Yandex Music token is stored; the token itself stays in Main. */
  yandexTokenSaved: boolean
  tools: PipelineTools
  job: PipelineJob | null
  /** Build stamp, so a stale bundle is visible in the interface. */
  version: string
  build: string
}

export interface AudioCandidate {
  id: string
  url: string
  title: string
  channel: string | null
  durationSeconds: number | null
}

export interface AcoustidRecording {
  recordingId: string | null
  title: string
  artist: string | null
  durationSeconds: number | null
  isrcs: string[]
  score: number
}

export const pipelineWorkerLimits = { min: 1, max: 5 } as const
export const pipelineImportConcurrency = 3
export const pipelineVerificationRate = { requests: 3, perSeconds: 1 } as const
export const pipelineMetadataRate = { requests: 1, perSeconds: 1 } as const
export const pipelineDeezerRate = { requests: 5, perSeconds: 1 } as const
export const pipelineSpotifyRate = { requests: 5, perSeconds: 1 } as const

/**
 * AcoustID application keys are public by design: they identify the app, not
 * the user. This shared key keeps the first import working without sign-up;
 * anyone can paste a personal key in the advanced settings instead.
 */
export const builtInAcoustidKey = 'Dm8hohLsF5'

/** Providers that read the track list from the user's own browser session. */
export const webSourceProviders = ['ytmusic', 'yandex', 'vk', 'soundcloud'] as const
export type WebSourceProvider = typeof webSourceProviders[number]

export interface WebSourceState {
  open: boolean
  provider: WebSourceProvider | null
  url: string | null
  title: string | null
}

/** Renderer viewport rectangle, in CSS pixels. */
export interface WebSourceBounds {
  x: number
  y: number
  width: number
  height: number
}
