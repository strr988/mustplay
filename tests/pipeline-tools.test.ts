import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { ToolManager } from '../src/pipeline/tools'
import { runProcess } from '../src/audio/process'

vi.mock('../src/audio/process', () => ({
  runProcess: vi.fn().mockRejectedValue(new Error('Not installed')),
}))

it('rejects a changed executable and an oversized archive before publishing or running them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mustplay-tools-test-'))
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('yt-dlp')) return new Response('unexpected contents')
    return new Response(new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024)
        for (let i = 0; i < 9; i++) controller.enqueue(chunk)
        controller.close()
      },
    }))
  })
  vi.stubGlobal('fetch', fetchMock)
  try {
    const status = await new ToolManager(directory).install()
    expect(status.ytDlp).toMatchObject({ installed: false, hint: expect.stringContaining('Контрольная сумма') })
    expect(status.fpcalc).toMatchObject({ installed: false, hint: expect.stringContaining('Размер инструмента') })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/releases/download/2026.10.26/'),
      expect.stringContaining('/releases/download/v1.6.0/'),
    ])
    expect(await readdir(directory)).toEqual([])
    expect(vi.mocked(runProcess).mock.calls.every(([path]) => !path.includes(directory) && path !== 'tar')).toBe(true)
  } finally {
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  }
})
