import { spawn } from 'node:child_process'

export interface ProcessResult {
  stdout: string
  stderr: string
  code: number
}

export class ProcessError extends Error {
  constructor(command: string, readonly code: number | null, readonly stderr: string) {
    super(`${command} завершился с кодом ${code ?? 'неизвестно'}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`)
    this.name = 'ProcessError'
  }
}

const outputLimit = 4 * 1024 * 1024

export function runProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      action()
    }
    const timer = options.timeoutMs
      ? setTimeout(() => {
        child.kill('SIGKILL')
        finish(() => reject(new ProcessError(command, null, 'превышено время ожидания')))
      }, options.timeoutMs)
      : undefined
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < outputLimit) stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < outputLimit) stderr += chunk
    })
    child.on('error', error => finish(() => reject(error)))
    child.on('close', code => finish(() => {
      if (code === 0) resolve({ stdout, stderr, code })
      else reject(new ProcessError(command, code, stderr))
    }))
  })
}
