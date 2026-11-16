import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/library-store'

// Two lines diverged after the shared schema 12: 0.9.0 added `yandex_settings`
// as 13, while the pipeline added `isrc_cache` and `pipeline_jobs` as 12 and
// 13, ending at 14. After the merge both must upgrade without replaying the
// migration the other line already ran — that is what the table probes and
// `schema_migrations` exist for.

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'mustplay-schema-'))
})

afterEach(async () => {
  await rm(folder, { recursive: true, force: true })
})

function tables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(row => row.name)
}

function recorded(db: DatabaseSync): string[] {
  return (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as { name: string }[])
    .map(row => row.name)
}

it('upgrades a 0.9.0 library and keeps its Yandex settings', () => {
  const path = join(folder, 'library.sqlite3')
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    db.exec(`DROP TABLE schema_migrations; DROP TABLE isrc_cache; DROP TABLE pipeline_jobs; PRAGMA user_version = 13`)
    db.prepare("UPDATE yandex_settings SET quality = 'lossless', folder = 'C:/Music'").run()
  }

  const store = new LibraryStore(path)
  try {
    expect(store.getYandexSettings()).toMatchObject({ quality: 'lossless', folder: 'C:/Music' })
  } finally {
    store.close()
  }

  using db = new DatabaseSync(path)
  expect(tables(db)).toEqual(expect.arrayContaining(['isrc_cache', 'pipeline_jobs', 'yandex_settings']))
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 })
})

it('upgrades a 0.10.0 library and adds the Yandex defaults once', () => {
  const path = join(folder, 'library.sqlite3')
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    db.exec(`DROP TABLE schema_migrations; DROP TABLE yandex_settings; PRAGMA user_version = 14`)
    db.prepare("INSERT INTO isrc_cache VALUES ('USRC17607839', NULL, 'song.m4a', 'deezer', '2026-01-01')").run()
  }

  const store = new LibraryStore(path)
  try {
    expect(store.getYandexSettings()).toEqual({
      token: null, tokenEncrypted: false, quality: 'nq', lyrics: 'lrc', embedCover: true, folder: null,
    })
  } finally {
    store.close()
  }

  using db = new DatabaseSync(path)
  // The cache table of the pipeline line survives, and its row is untouched.
  expect(db.prepare('SELECT isrc FROM isrc_cache').get()).toEqual({ isrc: 'USRC17607839' })
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 })
})

it('records every applied migration by name and does not repeat itself', async () => {
  const path = join(folder, 'library.sqlite3')
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    const names = recorded(db)
    expect(names).toHaveLength(15)
    expect(names).toEqual(expect.arrayContaining([
      'tracks-and-sources', 'audio-formats', 'isrc-fingerprint-cache', 'pipeline-jobs', 'yandex-settings',
    ]))
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 15 })
  }

  // A second open must not migrate, so it neither adds rows nor writes a backup.
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    expect(recorded(db)).toHaveLength(15)
  }
  expect((await readdir(folder)).filter(file => file.endsWith('.backup'))).toEqual([])
})
