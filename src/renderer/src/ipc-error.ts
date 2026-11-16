/**
 * Electron wraps every rejected IPC handler as
 * `Error invoking remote method 'pipeline:start': Error: <real text>`.
 * That prefix is an implementation detail and must never reach the user.
 */
const invocationPrefix = /^Error invoking remote method '[^']*':\s*/
const repeatedErrorPrefix = /^(?:Error:\s*)+/i

export function humanizeIpcError(error: unknown, fallback = 'Не удалось выполнить действие.'): string {
  const raw = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : ''
  const text = raw
    .trim()
    .replace(invocationPrefix, '')
    .replace(repeatedErrorPrefix, '')
    .trim()
  return text || fallback
}
