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
  providerId: string | null
}

export interface ProviderPlaylist {
  name: string
  tracks: PipelineTrackInput[]
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
  durationSeconds: number | null
  isrc: string | null
  status: PipelineItemStatus
  method: PipelineMethod
  confidence: number | null
  filePath: string | null
  message: string | null
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
}

export interface PipelineSettings {
  spotifyClientId: string
  acoustidKey: string
  downloadDir: string
  workers: number
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
  tools: PipelineTools
  job: PipelineJob | null
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
