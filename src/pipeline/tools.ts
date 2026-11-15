import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { PipelineTools } from '../shared/pipeline'
import { runProcess } from '../audio/process'

export type PipelineToolName = 'ytDlp' | 'fpcalc'

const isWindows = process.platform === 'win32'

const binaryName: Record<PipelineToolName, string> = {
  ytDlp: isWindows ? 'yt-dlp.exe' : 'yt-dlp',
  fpcalc: isWindows ? 'fpcalc.exe' : 'fpcalc',
}

const probeArguments: Record<PipelineToolName, string[]> = {
  ytDlp: ['--version'],
  fpcalc: ['-version'],
}

const toolHints: Record<PipelineToolName, string> = {
  ytDlp: 'yt-dlp не найден. Нажмите «Установить инструменты».',
  fpcalc: 'fpcalc (Chromaprint) не найден. Нажмите «Установить инструменты».',
}

const ytDlpDownloadUrl = isWindows
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : process.platform === 'darwin'
    ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
    : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'

function fpcalcAssetPattern(): RegExp {
  if (isWindows) return /windows-x86_64\.zip$/i
  if (process.platform === 'darwin') return /macos-universal\.tar\.gz$/i
  return process.arch === 'arm64' ? /linux-arm64\.tar\.gz$/i : /linux-x86_64\.tar\.gz$/i
}

interface GithubAsset {
  name?: unknown
  browser_download_url?: unknown
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Не удалось скачать ${basename(destination)} (${response.status})`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function findFile(root: string, fileName: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findFile(full, fileName)
      if (nested) return nested
    } else if (entry.name === fileName) {
      return full
    }
  }
  return null
}

async function extractArchive(archive: string, toolsDir: string, fileName: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), 'mustplay-tools-'))
  try {
    await runProcess('tar', ['-xf', archive, '-C', work], { timeoutMs: 120_000 })
    const found = await findFile(work, fileName)
    if (!found) throw new Error(`В архиве не найден ${fileName}`)
    const destination = join(toolsDir, fileName)
    await copyFile(found, destination)
    if (!isWindows) await chmod(destination, 0o755)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function fpcalcDownloadUrl(): Promise<string> {
  const response = await fetch('https://api.github.com/repos/acoustid/chromaprint/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!response.ok) throw new Error(`GitHub ответил ${response.status} при поиске Chromaprint`)
  const release = await response.json() as { assets?: GithubAsset[] }
  const pattern = fpcalcAssetPattern()
  const asset = (release.assets ?? []).find(item =>
    typeof item.name === 'string' && pattern.test(item.name) &&
    typeof item.browser_download_url === 'string')
  if (!asset || typeof asset.browser_download_url !== 'string') {
    throw new Error('Не найден архив Chromaprint для этой платформы')
  }
  return asset.browser_download_url
}

/**
 * Locates and installs the two external binaries the import pipeline needs.
 * Everything is downloaded from the official GitHub releases into the user's
 * profile directory, so the project stays free and self-contained.
 */
export class ToolManager {
  private readonly cache = new Map<PipelineToolName, string | null>()
  private readonly lastErrors = new Map<PipelineToolName, string>()
  private installing: Promise<PipelineTools> | null = null

  constructor(private readonly toolsDir: string) {}

  private candidates(name: PipelineToolName): string[] {
    return [join(this.toolsDir, binaryName[name])]
  }

  private async probe(name: PipelineToolName): Promise<string | null> {
    for (const candidate of this.candidates(name)) {
      if (!existsSync(candidate)) continue
      try {
        await runProcess(candidate, probeArguments[name], { timeoutMs: 20_000 })
        return candidate
      } catch {
        // File exists but does not run: fall through to PATH lookup.
      }
    }
    try {
      await runProcess(binaryName[name], probeArguments[name], { timeoutMs: 20_000 })
      return binaryName[name]
    } catch {
      return null
    }
  }

  private async resolve(name: PipelineToolName): Promise<string | null> {
    if (!this.cache.has(name)) this.cache.set(name, await this.probe(name))
    return this.cache.get(name) ?? null
  }

  binary(name: PipelineToolName): string | null {
    return this.cache.get(name) ?? null
  }

  async status(): Promise<PipelineTools> {
    const [ytDlp, fpcalc] = await Promise.all([this.resolve('ytDlp'), this.resolve('fpcalc')])
    return { ytDlp: this.state('ytDlp', ytDlp), fpcalc: this.state('fpcalc', fpcalc) }
  }

  private state(name: PipelineToolName, binary: string | null) {
    const error = this.lastErrors.get(name)
    return {
      name,
      installed: binary !== null,
      hint: binary !== null ? 'Установлен' : error ? `Не удалось установить: ${error}` : toolHints[name],
    }
  }

  install(): Promise<PipelineTools> {
    if (!this.installing) this.installing = this.runInstall().finally(() => { this.installing = null })
    return this.installing
  }

  private async runInstall(): Promise<PipelineTools> {
    await mkdir(this.toolsDir, { recursive: true })
    this.cache.clear()
    this.lastErrors.clear()
    const tasks: Promise<void>[] = []
    if (!(await this.resolve('ytDlp'))) tasks.push(this.installYtDlp())
    if (!(await this.resolve('fpcalc'))) tasks.push(this.installFpcalc())
    await Promise.all(tasks)
    this.cache.clear()
    return this.status()
  }

  private async installYtDlp(): Promise<void> {
    try {
      await download(ytDlpDownloadUrl, join(this.toolsDir, binaryName.ytDlp))
      if (!isWindows) await chmod(join(this.toolsDir, binaryName.ytDlp), 0o755)
    } catch (error) {
      this.lastErrors.set('ytDlp', error instanceof Error ? error.message : 'неизвестная ошибка')
    }
  }

  private async installFpcalc(): Promise<void> {
    const archive = join(this.toolsDir, 'chromaprint.zip')
    try {
      const url = await fpcalcDownloadUrl()
      await download(url, archive)
      await extractArchive(archive, this.toolsDir, binaryName.fpcalc)
    } catch (error) {
      this.lastErrors.set('fpcalc', error instanceof Error ? error.message : 'неизвестная ошибка')
    } finally {
      await rm(archive, { force: true })
    }
  }
}
