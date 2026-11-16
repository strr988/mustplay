import { artworkMime } from './artwork'

const maxCacheBytes = 16 * 1024 * 1024
const maxCacheEntries = 256
const maxUriEntries = 2_000

interface Cover {
  bytes: Uint8Array<ArrayBuffer>
  mime: 'image/png' | 'image/jpeg'
}

export type FetchCover = (coverUri: string, signal?: AbortSignal) => Promise<Buffer>

export class YandexCoverProxy {
  private readonly uris = new Map<string, string>()
  private readonly cache = new Map<string, Cover | null>()
  private cacheBytes = 0

  constructor(private readonly fetchCover: FetchCover) {}

  register(trackId: string, coverUri: string | null): void {
    if (!coverUri) return
    this.uris.set(trackId, coverUri)
    while (this.uris.size > maxUriEntries) this.uris.delete(this.uris.keys().next().value!)
  }

  private store(trackId: string, cover: Cover | null): void {
    const previous = this.cache.get(trackId)
    if (previous !== undefined) {
      this.cache.delete(trackId)
      this.cacheBytes -= previous?.bytes.length ?? 0
    }
    this.cache.set(trackId, cover)
    this.cacheBytes += cover?.bytes.length ?? 0
    while (this.cacheBytes > maxCacheBytes || this.cache.size > maxCacheEntries) {
      const oldest = this.cache.keys().next().value!
      this.cacheBytes -= this.cache.get(oldest)?.bytes.length ?? 0
      this.cache.delete(oldest)
    }
  }

  async read(trackId: string, signal?: AbortSignal): Promise<Cover | null> {
    const cached = this.cache.get(trackId)
    if (cached !== undefined) {
      this.cache.delete(trackId)
      this.cache.set(trackId, cached)
      return cached
    }
    const uri = this.uris.get(trackId)
    if (!uri) return null
    let cover: Cover | null = null
    try {
      const data = await this.fetchCover(uri, signal)
      const mime = artworkMime(data)
      if (mime) cover = { mime, bytes: new Uint8Array(data) }
    } catch {
      // A missing or invalid cover only affects the picture, not the download.
    }
    if (!signal?.aborted) this.store(trackId, cover)
    return cover
  }

  async serve(request: Request, trackId: string): Promise<Response> {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    const cover = await this.read(trackId, request.signal)
    if (!cover) return new Response(null, { status: 404, headers })
    return new Response(request.method === 'HEAD' ? null : cover.bytes, {
      headers: { ...headers, 'Content-Type': cover.mime, 'Content-Length': String(cover.bytes.length) },
    })
  }
}