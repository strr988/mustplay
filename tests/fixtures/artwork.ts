function syncSafe(value: number): Buffer {
  return Buffer.from([value >>> 21, value >>> 14, value >>> 7, value].map(byte => byte & 0x7f))
}

function id3Frame(id: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), syncSafe(data.length), Buffer.alloc(2), data])
}

export function mp3WithArtwork(audio: Buffer, image: Buffer, mime = 'image/jpeg'): Buffer {
  return mp3WithMetadata(audio, {
    title: 'Test Tone MP3',
    artist: 'Тестовый исполнитель',
    album: 'Fixture Album',
  }, { image, mime })
}

export function mp3WithMetadata(audio: Buffer, metadata: { title: string; artist: string; album: string },
  artwork?: { image: Buffer; mime: string }): Buffer {
  const originalTagSize = audio.subarray(6, 10).reduce((size, byte) => size * 128 + byte, 0)
  const text = (value: string) => Buffer.from('\x03' + value + '\x00')
  const frames = [
    id3Frame('TIT2', text(metadata.title)),
    id3Frame('TPE1', text(metadata.artist)),
    id3Frame('TALB', text(metadata.album)),
  ]
  if (artwork) {
    const { image, mime } = artwork
    frames.push(id3Frame('APIC', Buffer.concat([Buffer.from(`\x00${mime}\x00\x03\x00`), image])))
  }
  const tag = Buffer.concat(frames)
  return Buffer.concat([audio.subarray(0, 6), syncSafe(tag.length), tag, audio.subarray(10 + originalTagSize)])
}

export function flacWithArtwork(audio: Buffer, image: Buffer): Buffer {
  const mime = Buffer.from('image/png')
  const picture = Buffer.alloc(32 + mime.length)
  picture.writeUInt32BE(3, 0) // Front cover
  picture.writeUInt32BE(mime.length, 4)
  mime.copy(picture, 8)
  picture.writeUInt32BE(12, 12 + mime.length)
  picture.writeUInt32BE(12, 16 + mime.length)
  picture.writeUInt32BE(24, 20 + mime.length)
  picture.writeUInt32BE(image.length, 28 + mime.length)
  const header = Buffer.alloc(4)
  header[0] = 6 // PICTURE
  header.writeUIntBE(picture.length + image.length, 1, 3)
  const streamInfoEnd = 8 + audio.readUIntBE(5, 3)
  return Buffer.concat([audio.subarray(0, streamInfoEnd), header, picture, image, audio.subarray(streamInfoEnd)])
}

/** Extend the fixture's mdat without moving the AAC samples it points to. */
export function m4aWithLargeMediaAtom(audio: Buffer): Buffer {
  const head = Buffer.from(audio)
  for (let offset = 0; offset + 8 <= head.length;) {
    const size = head.readUInt32BE(offset)
    if (size < 8 || offset + size > head.length) break
    if (head.toString('latin1', offset + 4, offset + 8) === 'mdat') {
      const padding = Buffer.alloc(8 * 1024 * 1024 + 17)
      head.writeUInt32BE(size + padding.length, offset)
      return Buffer.concat([head.subarray(0, offset + size), padding, head.subarray(offset + size)])
    }
    offset += size
  }
  throw new Error('Missing mdat in AAC fixture')
}
