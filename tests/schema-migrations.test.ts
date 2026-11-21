import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises'
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
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
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
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
})

it('records every applied migration by name and does not repeat itself', async () => {
  const path = join(folder, 'library.sqlite3')
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    const names = recorded(db)
    expect(names).toHaveLength(16)
    expect(names).toEqual(expect.arrayContaining([
      'tracks-and-sources', 'audio-formats', 'isrc-fingerprint-cache', 'pipeline-jobs', 'yandex-settings', 'system-theme',
    ]))
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
  }

  // A second open must not migrate, so it neither adds rows nor writes a backup.
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    expect(recorded(db)).toHaveLength(16)
  }
  expect((await readdir(folder)).filter(file => file.endsWith('.backup'))).toEqual([])
})

it('preserves the 0.11.0 theme on upgrade and remembers system mode', () => {
  const path = join(folder, 'library.sqlite3')
  new LibraryStore(path).close()
  {
    using db = new DatabaseSync(path)
    db.exec("DELETE FROM schema_migrations WHERE name = 'system-theme'; PRAGMA user_version = 15")
    db.exec(`ALTER TABLE appearance_settings DROP COLUMN theme;
      ALTER TABLE appearance_settings ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light'));
      UPDATE appearance_settings SET theme = 'light';`)
  }
  const migrated = new LibraryStore(path)
  try {
    expect(migrated.getTheme()).toBe('light')
    migrated.setTheme('system')
  } finally {
    migrated.close()
  }
  const reopened = new LibraryStore(path)
  try {
    expect(reopened.getTheme()).toBe('system')
  } finally {
    reopened.close()
  }
})

const historical = (version: string) => new URL('./fixtures/historical-libraries/' + version + '.sqlite', import.meta.url)

const profileTables = ['tracks', 'playlists', 'playlist_items', 'track_preferences', 'playback_events',
  'appearance_settings', 'wave_settings', 'yandex_settings', 'isrc_cache', 'fingerprint_cache']

function snapshot(db: DatabaseSync) {
  return Object.fromEntries(profileTables.filter(name =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name))
    .map(name => [name, db.prepare('SELECT * FROM ' + name).all()]))
}

it.each([['0.8.0', 12], ['0.9.0-yandex', 13], ['0.10.0', 14]] as const)(
  'migrates a populated database created by release %s', async (version, schema) => {
    const path = join(folder, 'profile.sqlite')
    await copyFile(historical(version), path)
    using original = new DatabaseSync(historical(version), { readOnly: true })
    expect(original.prepare('PRAGMA user_version').get()).toEqual({ user_version: schema })
    const before = snapshot(original)

    new LibraryStore(path).close()
    new LibraryStore(path).close()
    using current = new DatabaseSync(path, { readOnly: true })
    expect(current.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
    expect(current.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(snapshot(current)).toMatchObject(before)
  },
)

it('recovers the pre-upgrade profile after a failed migration', async () => {
  const path = join(folder, 'profile.sqlite')
  await copyFile(historical('0.10.0'), path)
  using original = new DatabaseSync(historical('0.10.0'), { readOnly: true })
  const before = snapshot(original)
  {
    using profile = new DatabaseSync(path)
    profile.exec('CREATE VIEW yandex_settings AS SELECT 1')
  }

  expect(() => new LibraryStore(path)).toThrow(/yandex_settings/i)
  {
    using failed = new DatabaseSync(path, { readOnly: true })
    expect(failed.prepare('PRAGMA user_version').get()).toEqual({ user_version: 14 })
    expect(snapshot(failed)).toEqual(before)
  }
  const backups = (await readdir(folder)).filter(file => file.endsWith('.backup'))
  expect(backups).toHaveLength(1)
  const restored = join(folder, 'restored.sqlite')
  await copyFile(join(folder, backups[0]), restored)
  {
    using previous = new DatabaseSync(restored)
    expect(previous.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
    expect(snapshot(previous)).toEqual(before)
    previous.exec('DROP VIEW yandex_settings')
  }
  new LibraryStore(restored).close()
  using current = new DatabaseSync(restored, { readOnly: true })
  expect(current.prepare('PRAGMA user_version').get()).toEqual({ user_version: 16 })
  expect(snapshot(current)).toMatchObject(before)
})
