import type { YandexQuality } from '../shared/contracts'

export interface CoverImage {
  data: Buffer
  mime: 'image/jpeg' | 'image/png'
}

export interface TrackTags {
  title: string
  album: string
  artists: string[]
  albumArtists: string[]
  date: string | null
  trackNumber: number | null
  discNumber: number | null
  genre: string | null
  lyrics: string | null
  comment: string | null
  cover: CoverImage | null
}

export type TagContainer = 'mp3' | 'flac' | 'm4a'

export function containerForCodec(codec: string): { container: TagContainer; extension: string } | null {
  switch (codec) {
    case 'flac': return { container: 'flac', extension: '.flac' }
    case 'flac-mp4': return { container: 'm4a', extension: '.m4a' }
    case 'mp3': return { container: 'mp3', extension: '.mp3' }
    case 'aac':
    case 'he-aac':
    case 'aac-mp4':
    case 'he-aac-mp4': return { container: 'm4a', extension: '.m4a' }
    default: return null
  }
}

export function qualityLabel(quality: YandexQuality): string {
  return quality === 'lossless' ? 'Lossless' : quality === 'nq' ? 'Высокое' : 'Экономное'
}

function syncSafe(value: number): Buffer {
  return Buffer.from([value >>> 21, value >>> 14, value >>> 7, value].map(byte => byte & 0x7f))
}

function stripId3(bytes: Buffer): Buffer {
  if (bytes.length < 10 || bytes.toString('latin1', 0, 3) !== 'ID3') return bytes
  const version = bytes[3]
  const size = bytes.subarray(6, 10).reduce((total, byte) => total * 128 + byte, 0)
  const footer = version === 4 && (bytes[5] & 0x10) ? 10 : 0
  const end = 10 + size + footer
  return end <= bytes.length ? bytes.subarray(end) : bytes
}

function id3TextFrame(id: string, value: string): Buffer {
  const data = Buffer.concat([Buffer.from([0x03]), Buffer.from(value, 'utf8'), Buffer.from([0x00])])
  const header = Buffer.alloc(10)
  header.write(id, 0, 'latin1')
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function id3PictureFrame(cover: CoverImage): Buffer {
  const data = Buffer.concat([
    Buffer.from([0x03]),
    Buffer.from(cover.mime, 'latin1'), Buffer.from([0x00]),
    Buffer.from([0x03]),
    Buffer.from([0x00]),
    cover.data,
  ])
  const header = Buffer.alloc(10)
  header.write('APIC', 0, 'latin1')
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function id3LyricsFrame(lyrics: string): Buffer {
  const data = Buffer.concat([
    Buffer.from([0x03]), Buffer.from('eng', 'latin1'), Buffer.from([0x00]), Buffer.from(lyrics, 'utf8'),
  ])
  const header = Buffer.alloc(10)
  header.write('USLT', 0, 'latin1')
  header.writeUInt32BE(data.length, 4)
  return Buffer.concat([header, data])
}

function writeId3(audio: Buffer, tags: TrackTags): Buffer {
  const frames: Buffer[] = [
    id3TextFrame('TIT2', tags.title),
    id3TextFrame('TALB', tags.album),
    id3TextFrame('TPE1', tags.artists.join(', ')),
    id3TextFrame('TPE2', tags.albumArtists.join(', ')),
  ]
  if (tags.date) frames.push(id3TextFrame('TDRC', tags.date))
  if (tags.trackNumber) frames.push(id3TextFrame('TRCK', String(tags.trackNumber)))
  if (tags.discNumber) frames.push(id3TextFrame('TPOS', String(tags.discNumber)))
  if (tags.genre) frames.push(id3TextFrame('TCON', tags.genre))
  if (tags.lyrics) frames.push(id3LyricsFrame(tags.lyrics))
  if (tags.cover) frames.push(id3PictureFrame(tags.cover))
  if (tags.comment) frames.push(id3TextFrame('COMM', tags.comment))
  const body = Buffer.concat(frames)
  const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x03, 0x00, 0x00]), syncSafe(body.length)])
  return Buffer.concat([header, body, stripId3(audio)])
}

function flacBlock(type: number, data: Buffer, last: boolean): Buffer {
  const header = Buffer.alloc(4)
  header[0] = (last ? 0x80 : 0x00) | type
  header.writeUIntBE(data.length, 1, 3)
  return Buffer.concat([header, data])
}

function vorbisComment(tags: TrackTags): Buffer {
  const vendor = Buffer.from('mustplay', 'utf8')
  const comments: string[] = [`TITLE=${tags.title}`, `ALBUM=${tags.album}`]
  for (const artist of tags.artists) comments.push(`ARTIST=${artist}`)
  for (const artist of tags.albumArtists) comments.push(`ALBUMARTIST=${artist}`)
  if (tags.date) comments.push(`DATE=${tags.date}`)
  if (tags.trackNumber) comments.push(`TRACKNUMBER=${tags.trackNumber}`)
  if (tags.discNumber) comments.push(`DISCNUMBER=${tags.discNumber}`)
  if (tags.genre) comments.push(`GENRE=${tags.genre}`)
  if (tags.lyrics) comments.push(`LYRICS=${tags.lyrics}`)
  if (tags.comment) comments.push(`COMMENT=${tags.comment}`)
  const parts: Buffer[] = []
  const length = Buffer.alloc(4)
  length.writeUInt32LE(vendor.length, 0)
  parts.push(length, vendor)
  const count = Buffer.alloc(4)
  count.writeUInt32LE(comments.length, 0)
  parts.push(count)
  for (const comment of comments) {
    const bytes = Buffer.from(comment, 'utf8')
    const size = Buffer.alloc(4)
    size.writeUInt32LE(bytes.length, 0)
    parts.push(size, bytes)
  }
  return Buffer.concat(parts)
}

function flacPicture(cover: CoverImage): Buffer {
  const mime = Buffer.from(cover.mime, 'latin1')
  const header = Buffer.alloc(32)
  header.writeUInt32BE(3, 0)
  header.writeUInt32BE(mime.length, 4)
  // Width, height, depth and color count stay zero; readers derive them from the image.
  header.writeUInt32BE(cover.data.length, 28)
  return Buffer.concat([header.subarray(0, 8), mime, header.subarray(8), cover.data])
}

function writeFlac(audio: Buffer, tags: TrackTags): Buffer {
  if (audio.toString('latin1', 0, 4) !== 'fLaC') throw new Error('Ожидался поток FLAC')
  const kept: { type: number; data: Buffer }[] = []
  let offset = 4
  let streamInfoSeen = false
  while (offset + 4 <= audio.length) {
    const header = audio[offset]
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = audio.readUIntBE(offset + 1, 3)
    const start = offset + 4
    const end = start + length
    if (end > audio.length) break
    if (type === 0) streamInfoSeen = true
    if (type !== 4 && type !== 6) kept.push({ type, data: audio.subarray(start, end) })
    offset = end
    if (last) break
  }
  if (!streamInfoSeen) throw new Error('В потоке FLAC нет блока STREAMINFO')
  const blocks: Buffer[] = [Buffer.from('fLaC', 'latin1')]
  const extra: { type: number; data: Buffer }[] = [{ type: 4, data: vorbisComment(tags) }]
  if (tags.cover) extra.push({ type: 6, data: flacPicture(tags.cover) })
  const all = [...kept, ...extra]
  all.forEach((block, index) => blocks.push(flacBlock(block.type, block.data, index === all.length - 1)))
  return Buffer.concat([...blocks, audio.subarray(offset)])
}

interface Atom {
  type: string
  data: Buffer
  prefix?: Buffer
  children?: Atom[]
}

const containerAtoms = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf', 'mvex', 'meta', 'moof', 'traf'])

function parseAtoms(bytes: Buffer, start: number, end: number): Atom[] {
  const atoms: Atom[] = []
  let offset = start
  while (offset + 8 <= end) {
    let size = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) break
      size = Number(bytes.readBigUInt64BE(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < headerSize || offset + size > end) break
    const payloadStart = offset + headerSize
    const payloadEnd = offset + size
    const atom: Atom = { type, data: bytes.subarray(payloadStart, payloadEnd) }
    if (containerAtoms.has(type)) {
      if (type === 'meta') {
        atom.prefix = bytes.subarray(payloadStart, payloadStart + 4)
        atom.children = parseAtoms(bytes, payloadStart + 4, payloadEnd)
      } else {
        atom.children = parseAtoms(bytes, payloadStart, payloadEnd)
      }
    }
    atoms.push(atom)
    offset = payloadEnd
  }
  return atoms
}

function atomHeader(type: string, length: number): Buffer {
  if (length + 8 <= 0xffffffff) {
    const header = Buffer.alloc(8)
    header.writeUInt32BE(length + 8, 0)
    header.write(type, 4, 'latin1')
    return header
  }
  const header = Buffer.alloc(16)
  header.writeUInt32BE(1, 0)
  header.write(type, 4, 'latin1')
  header.writeBigUInt64BE(BigInt(length + 16), 8)
  return header
}

function serializeAtom(atom: Atom): Buffer {
  if (atom.children) {
    const body = Buffer.concat([atom.prefix ?? Buffer.alloc(0), ...atom.children.map(serializeAtom)])
    return Buffer.concat([atomHeader(atom.type, body.length), body])
  }
  return Buffer.concat([atomHeader(atom.type, atom.data.length), atom.data])
}

function findChild(atom: Atom, type: string): Atom | undefined {
  return atom.children?.find(child => child.type === type)
}

function ensureChild(atom: Atom, type: string, prefix?: Buffer): Atom {
  atom.children ??= []
  let child = findChild(atom, type)
  if (!child) {
    child = { type, data: Buffer.alloc(0), children: [], prefix }
    atom.children.push(child)
  }
  return child
}

function dataAtom(indicator: number, value: Buffer): Atom {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(indicator, 0)
  return { type: 'data', data: Buffer.concat([header, value]) }
}

function textEntry(key: string, value: string): Atom {
  return { type: key, data: Buffer.alloc(0), children: [dataAtom(1, Buffer.from(value, 'utf8'))] }
}

function numberEntry(key: string, value: number): Atom {
  const payload = Buffer.alloc(8)
  payload.writeUInt16BE(value, 2)
  return { type: key, data: Buffer.alloc(0), children: [dataAtom(0, payload)] }
}

function buildIlst(tags: TrackTags): Atom {
  const entries: Atom[] = [
    textEntry('©nam', tags.title),
    textEntry('©alb', tags.album),
    textEntry('©ART', tags.artists.join('; ')),
    textEntry('aART', tags.albumArtists.join('; ')),
  ]
  if (tags.date) entries.push(textEntry('©day', tags.date))
  if (tags.trackNumber) entries.push(numberEntry('trkn', tags.trackNumber))
  if (tags.discNumber) entries.push(numberEntry('disk', tags.discNumber))
  if (tags.genre) entries.push(textEntry('©gen', tags.genre))
  if (tags.lyrics) entries.push(textEntry('©lyr', tags.lyrics))
  if (tags.comment) entries.push(textEntry('©cmt', tags.comment))
  if (tags.cover) entries.push({
    type: 'covr', data: Buffer.alloc(0),
    children: [dataAtom(tags.cover.mime === 'image/png' ? 14 : 13, tags.cover.data)],
  })
  return { type: 'ilst', data: Buffer.alloc(0), children: entries }
}

function patchOffsets(atom: Atom, delta: number): void {
  if (atom.type === 'stco' && atom.data.length >= 8) {
    const count = atom.data.readUInt32BE(4)
    for (let index = 0; index < count && 8 + index * 4 + 4 <= atom.data.length; index++) {
      const at = 8 + index * 4
      atom.data.writeUInt32BE(atom.data.readUInt32BE(at) + delta, at)
    }
  }
  if (atom.type === 'co64' && atom.data.length >= 8) {
    const count = atom.data.readUInt32BE(4)
    for (let index = 0; index < count && 8 + index * 8 + 8 <= atom.data.length; index++) {
      const at = 8 + index * 8
      atom.data.writeBigUInt64BE(atom.data.readBigUInt64BE(at) + BigInt(delta), at)
    }
  }
  for (const child of atom.children ?? []) patchOffsets(child, delta)
}

function writeM4a(audio: Buffer, tags: TrackTags): Buffer {
  const roots = parseAtoms(audio, 0, audio.length)
  const moovIndex = roots.findIndex(atom => atom.type === 'moov')
  if (moovIndex < 0) throw new Error('В контейнере MP4 нет атома moov')
  const moov = roots[moovIndex]
  const oldSize = serializeAtom(moov).length
  const udta = ensureChild(moov, 'udta')
  const meta = ensureChild(udta, 'meta', Buffer.alloc(4))
  if (!findChild(meta, 'hdlr')) {
    const handler = Buffer.alloc(33)
    handler.write('mdir', 8, 'latin1')
    handler.write('appl', 12, 'latin1')
    meta.children ??= []
    meta.children.unshift({ type: 'hdlr', data: handler })
  }
  meta.children = (meta.children ?? []).filter(child => child.type !== 'ilst')
  meta.children.push(buildIlst(tags))
  const newSize = serializeAtom(moov).length
  const delta = newSize - oldSize
  const mdatIndex = roots.findIndex(atom => atom.type === 'mdat')
  if (delta !== 0 && mdatIndex > moovIndex) patchOffsets(moov, delta)
  return Buffer.concat(roots.map(serializeAtom))
}

export function writeTags(container: TagContainer, audio: Buffer, tags: TrackTags): Buffer {
  switch (container) {
    case 'mp3': return writeId3(audio, tags)
    case 'flac': return writeFlac(audio, tags)
    case 'm4a': return writeM4a(audio, tags)
  }
}