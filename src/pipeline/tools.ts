import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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

const ytDlpVersion = '2026.10.26'
const fpcalcVersion = '1.6.0'
const version: Record<PipelineToolName, string> = { ytDlp: ytDlpVersion, fpcalc: fpcalcVersion }

const ytDlp = isWindows
  ? ['yt-dlp.exe', 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d']
  : process.platform === 'darwin'
    ? ['yt-dlp_macos', '0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa']
    : ['yt-dlp', 'e51e69e89489f199530f13d32a4342da3ddb2cf34842f364603a066db05afbf3']
const fpcalc = isWindows
  ? ['windows-x86_64.zip', '30179d3d0dc4cc92f1a0995c1a2e523fb4867724c2ee6a6ceae474f8e4d6937a']
  : process.platform === 'darwin'
    ? ['macos-universal.tar.gz', '31f654cce8308fcb22869d043770eb66afffed95e8a548fd877f0e670c16d7ec']
    : process.arch === 'arm64'
      ? ['linux-arm64.tar.gz', 'c8667f556f77d8ebbe08b75a968c0592bd2a67aaa696eff91715feb5083b1cd4']
      : ['linux-x86_64.tar.gz', '946dc3eade645eb835c8d163c6bb354e092239988bff190b9c42589e8d5cf00a']

async function download(url: string, destination: string, sha256: string, maxBytes: number): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok || !response.body) throw new Error('Не удалось скачать ' + basename(destination))
  const reader = response.body.getReader()
  const digest = createHash('sha256')
  let bytes = 0
  try {
    const file = await open(destination, 'wx')
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > maxBytes) throw new Error('Размер инструмента превышает допустимый')
        digest.update(value)
        await file.writeFile(value)
      }
    } finally {
      await file.close()
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (digest.digest('hex') !== sha256) throw new Error('Контрольная сумма инструмента не совпадает')
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
    return [this.managedBinary(name)]
  }

  private managedBinary(name: PipelineToolName): string {
    return join(this.toolsDir, name + '-' + version[name], binaryName[name])
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
    await this.installVerified('ytDlp', async work => {
      const [asset, sha256] = ytDlp
      const binary = join(work, binaryName.ytDlp)
      await download('https://github.com/yt-dlp/yt-dlp/releases/download/' + ytDlpVersion + '/' + asset,
        binary, sha256, 64 * 1024 * 1024)
      return binary
    })
  }

  private async installFpcalc(): Promise<void> {
    await this.installVerified('fpcalc', async work => {
      const [suffix, sha256] = fpcalc
      const asset = 'chromaprint-fpcalc-' + fpcalcVersion + '-' + suffix
      const archive = join(work, asset)
      await download('https://github.com/acoustid/chromaprint/releases/download/v' + fpcalcVersion + '/' + asset,
        archive, sha256, 8 * 1024 * 1024)
      await runProcess('tar', ['-xf', archive, '-C', work], { timeoutMs: 120_000 })
      const binary = await findFile(work, binaryName.fpcalc)
      if (!binary) throw new Error('В архиве не найден fpcalc')
      return binary
    })
  }

  private async installVerified(name: PipelineToolName, prepare: (work: string) => Promise<string>): Promise<void> {
    try {
      const work = await mkdtemp(join(this.toolsDir, '.install-'))
      try {
        const binary = await prepare(work)
        if (!isWindows) await chmod(binary, 0o755)
        const destination = this.managedBinary(name)
        await mkdir(dirname(destination), { recursive: true })
        await rename(binary, destination)
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    } catch (error) {
      this.lastErrors.set(name, error instanceof Error ? error.message : 'неизвестная ошибка')
    }
  }
}
