import { net } from 'electron'
import type { ShortLinkReply, ShortLinkTransport } from './short-links'
import { maxSnippetBytes } from './short-links'

/**
 * Electron transport for the short-link resolver.
 *
 * `net.request` with `redirect: 'manual'` is used instead of `net.fetch`
 * because fetch cancels manual redirects in the main process, while
 * `net.request` reports the Location and lets us abort before the service
 * page is downloaded. It also uses Chromium's network stack, so the system
 * proxy and VPN that the rest of the app uses apply here as well.
 */
export const electronShortLinkTransport: ShortLinkTransport = {
  send(url, { method, userAgent, timeoutMs }): Promise<ShortLinkReply> {
    return new Promise((resolve, reject) => {
      const request = net.request({ method, url, redirect: 'manual' })
      request.setHeader('User-Agent', userAgent)
      request.setHeader('Accept', 'text/html,application/xhtml+xml,*/*')

      const chunks: Uint8Array[] = []
      let size = 0
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        request.abort()
        reject(new Error('превышено время ожидания'))
      }, timeoutMs)

      const finish = (reply: ShortLinkReply) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(reply)
      }
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }

      request.on('redirect', (status, _method, redirectUrl) => {
        // Settle first: abort() may emit 'error' synchronously, and that error
        // must not turn a perfectly good redirect into a network failure.
        finish({
          status,
          location: redirectUrl,
          body: async () => '',
          discard: async () => {},
        })
        // A redirect is the answer: stop before the page is fetched.
        request.abort()
      })

      request.on('response', response => {
        const status = response.statusCode
        response.on('data', (chunk: Buffer) => {
          if (method === 'GET' && size < maxSnippetBytes) {
            chunks.push(chunk)
            size += chunk.byteLength
          }
        })
        response.on('end', () => finish({
          status,
          location: null,
          body: async () => new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))),
          discard: async () => {},
        }))
        response.on('error', error => fail(error instanceof Error ? error : new Error(String(error))))
      })

      request.on('error', error => {
        // Aborting after a redirect is intentional and must not look like a failure.
        if (settled) return
        fail(error instanceof Error ? error : new Error(String(error)))
      })

      request.end()
    })
  },
}
