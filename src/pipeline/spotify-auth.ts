import { createServer } from 'node:http'

export interface SpotifyCallback {
  code: string
  state: string
}

const successPage = `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>mustplay</title>
<body style="font-family:system-ui,sans-serif;background:#101014;color:#f4f4f5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Spotify подключён</h1><p>Вернитесь в mustplay — окно можно закрыть.</p></div>`

const failurePage = (reason: string) => `<!doctype html><html lang="ru"><meta charset="utf-8">
<title>mustplay</title>
<body style="font-family:system-ui,sans-serif;background:#101014;color:#f4f4f5;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Не удалось подключить Spotify</h1><p>${reason.replace(/[<>&]/g, '')}</p><p>Вернитесь в mustplay и попробуйте снова.</p></div>`

/**
 * Temporary loopback listener for the Spotify PKCE redirect. Spotify sends the
 * browser back to http://127.0.0.1:<port>/callback, so the code never leaves
 * the machine and the user does not have to copy it by hand.
 */
export function waitForSpotifyCallback(
  expectedState: string,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<SpotifyCallback | null> {
  const port = options.port ?? 8888
  const timeoutMs = options.timeoutMs ?? 5 * 60_000
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: SpotifyCallback | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.close()
      resolve(value)
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      if (error) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(failurePage(error))
        finish(null)
      } else if (!code || !state || state !== expectedState) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(failurePage('Некорректный ответ авторизации'))
        finish(null)
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(successPage)
        finish({ code, state })
      }
    })
    const timer = setTimeout(() => finish(null), timeoutMs)
    server.on('error', () => finish(null))
    server.listen(port, '127.0.0.1')
  })
}
