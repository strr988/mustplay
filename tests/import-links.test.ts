import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  blockedLinkReason, detectImportLink, importActionLabel, linkNote, supportedLinks,
} from '../src/shared/import-links'
import { shortLinkSource } from '../src/imports/short-links'
import { parsePlaylistUrl } from '../src/metadata/providers/types'

interface CorpusEntry {
  why: string
  url: string
  provider: string | null
  kind?: string
  supported?: boolean
  short?: boolean
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/import-links.json', import.meta.url), 'utf8'),
) as CorpusEntry[]

describe('import link corpus', () => {
  it.each(corpus)('$why', entry => {
    const info = detectImportLink(entry.url)
    if (entry.provider === null) {
      expect(info).toBeNull()
      return
    }
    expect(info).not.toBeNull()
    expect(info).toMatchObject({
      provider: entry.provider,
      kind: entry.kind,
      supported: entry.supported,
    })
    expect(Boolean(info?.short)).toBe(Boolean(entry.short))
  })
})

describe('interface and backend agree', () => {
  // The button is enabled only when the backend parser can read the address.
  // The reverse is allowed: a recognised but unsupported provider (Yandex, VK)
  // is explained instead of attempted.
  it.each(corpus.filter(entry => entry.supported && !entry.short))(
    'enabled link is parsed by the pipeline: $url',
    entry => {
      const ref = parsePlaylistUrl(entry.url)
      expect(ref).not.toBeNull()
      expect(ref?.provider).toBe(entry.provider)
    },
  )

  it('every enabled short link belongs to a provider with a resolver', () => {
    for (const entry of corpus.filter(item => item.short && item.supported)) {
      expect(shortLinkSource(entry.url)?.provider).toBe(entry.provider)
    }
  })

  it('does not advertise a link the parser rejects', () => {
    expect(supportedLinks.length).toBeGreaterThan(0)
    for (const item of supportedLinks) {
      const info = detectImportLink(item.url)
      expect(info).toMatchObject({ provider: item.provider, kind: item.kind, supported: true })
      expect(parsePlaylistUrl(item.url)?.provider).toBe(item.provider)
    }
  })

  it('mentions the short form for every service that has one', () => {
    for (const item of supportedLinks) {
      const short = corpus.find(entry => entry.provider === item.provider && entry.short && entry.supported)
      expect(short, `no short link in the corpus for ${item.provider}`).toBeDefined()
    }
  })
})

describe('import copy', () => {
  it('explains a short link instead of asking for the full address', () => {
    const info = detectImportLink('https://on.soundcloud.com/abc123')
    expect(linkNote(info!, false)).toContain('развернём')
  })

  it('keeps Yandex visible but blocked, with the token state reflected', () => {
    const info = detectImportLink('https://music.yandex.ru/users/demo/playlists/1')!
    expect(blockedLinkReason(info, false)).toContain('Токен можно сохранить')
    expect(blockedLinkReason(info, true)).toContain('ещё не подключено')
  })

  it('names the action after the link kind', () => {
    expect(importActionLabel(detectImportLink('https://soundcloud.com/forss/sets/soulhack'))).toBe('Импортировать сет')
    expect(importActionLabel(detectImportLink('https://www.deezer.com/playlist/123'))).toBe('Импортировать плейлист')
    expect(importActionLabel(detectImportLink('https://on.soundcloud.com/abc'))).toBe('Импортировать')
    expect(importActionLabel(null)).toBe('Импортировать')
  })
})
