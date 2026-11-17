import type { FileHandle } from 'node:fs/promises'
import { parseBuffer, parseStream } from 'music-metadata'
import type { IAudioMetadata, IOptions } from 'music-metadata'
import { audioMime } from './audio-formats'
import type { LocalSource } from './library-store'
import { sameFile } from './local-file'

const metadataLimit = 8 * 1024 * 1024
const mp4AtomLimit = 4096

async function readMp4Movie(file: FileHandle, size: number): Promise<Buffer | null> {
  const header = Buffer.alloc(16)
  for (let offset = 0, count = 0; offset + 8 <= size && count < mp4AtomLimit; count++) {
    if ((await file.read(header, 0, 8, offset)).bytesRead !== 8) return null
    let length = header.readUInt32BE(0)
    let headerSize = 8
    if (length === 1) {
      if (offset + 16 > size || (await file.read(header, 8, 8, offset + 8)).bytesRead !== 8) return null
      length = Number(header.readBigUInt64BE(8))
      headerSize = 16
    } else if (length === 0) {
      length = size - offset
    }
    if (length < headerSize || length > size - offset) return null

    // A streamed prefix truncates mdat and can make the parser reject the
    // entire container, even when moov is at the front. Seek over media data.
    if (header.toString('latin1', 4, 8) === 'moov') {
      if (length > metadataLimit) return null
      const movie = Buffer.alloc(length)
      const { bytesRead } = await file.read(movie, 0, length, offset)
      return bytesRead === length ? movie : null
    }
    offset += length
  }
  return null
}

export async function parseSourceTags(
  file: FileHandle,
  source: LocalSource,
  options: Pick<IOptions, 'skipCovers' | 'maxMetadataEntries'>,
): Promise<IAudioMetadata | null> {
  const size = Number(source.identity.size)
  if (!Number.isSafeInteger(size) || size <= 0) return null
  const mimeType = audioMime[source.format]
  const limits = { ...options, maxMemoryAllocation: metadataLimit }
  if (source.format === 'm4a') {
    const movie = await readMp4Movie(file, size)
    if (!movie) return null
    const tags = await parseBuffer(movie, { mimeType, size: movie.length }, limits)
    return sameFile(source.identity, await file.stat({ bigint: true })) ? tags : null
  }

  const length = Math.min(size, metadataLimit)
  const stream = file.createReadStream({ start: 0, end: length - 1, autoClose: false })
  try {
    const tags = await parseStream(stream, { mimeType, size: length }, limits)
    return sameFile(source.identity, await file.stat({ bigint: true })) ? tags : null
  } finally {
    stream.destroy()
  }
}
