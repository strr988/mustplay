import { detectImportLink, hostMatches, importSources } from '../shared/import-links'

/**
 * Sharing links (`on.soundcloud.com/abc`, `spotify.link/abc`) are redirectors.
 * They are resolved in Main, before anything is parsed or downloaded, because
 * the redirect target is the only place the real address exists.
 *
 * Transport is injected on purpose: Chromium's `net.request` can read a
 * redirect without following it and honours the system proxy, while Node's
 * fetch is enough for tests and other callers.
 */

export type ShortLinkFailure = 'not-short' | 'network' | 'blocked' | 'blocked-host' | 'loop'

export class ShortLinkError extends Error {
  constructor(readonly kind: ShortLinkFailure, message: string) {
    super(message)
    this.name = 'ShortLinkError'
  }
}

export interface ShortLinkReply {
  status: number
  /** Redirect target, taken from the Location header without following it. */
  location: string | null
  /** Body text, requested only when the reply has no redirect. */
  body(): Promise<string>
  /** Releases the underlying response as soon as the answer is known. */
  discard(): Promise<void>
}

export interface ShortLinkTransport {
  send(
    url: string,
    options: { method: 'HEAD' | 'GET'; userAgent: string; timeoutMs: number },
  ): Promise<ShortLinkReply>
}

export interface ShortLinkOptions {
  transport?: ShortLinkTransport
  userAgent?: string
  maxHops?: number
  /** Per request, in milliseconds. */
  timeoutMs?: number
}

const defaultUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) mustplay/import'
export const maxSnippetBytes = 64 * 1024

export function shortLinkSource(raw: string): { provider: string; hosts: readonly string[] } | null {
  const url = parseUrl(raw)
  if (!url) return null
  const host = normalizeHost(url.hostname)
  const source = importSources.find(item => item.shortHosts?.some(domain => hostMatches(host, domain)))
  return source ? { provider: source.provider, hosts: source.hosts } : null
}

/**
 * Follows the shortener and returns the first full provider address. It stops
 * as soon as the target is a link the importer understands, so a blocked
 * service page does not need to be loaded just to learn its address.
 */
export async function resolveShortLink(raw: string, options: ShortLinkOptions = {}): Promise<string> {
  const transport = options.transport ?? fetchTransport()
  const timeoutMs = options.timeoutMs ?? 8_000
  const maxHops = options.maxHops ?? 5
  const userAgent = options.userAgent ?? defaultUserAgent

  const start = parseUrl(raw)
  if (!start) throw new ShortLinkError('not-short', 'Ссылка не похожа на адрес')
  if (start.protocol !== 'https:') throw new ShortLinkError('blocked', 'Короткая ссылка должна быть https')

  const startHost = normalizeHost(start.hostname)
  const source = importSources.find(item => item.shortHosts?.some(domain => hostMatches(startHost, domain)))
  if (!source) throw new ShortLinkError('not-short', 'Это не короткая ссылка сервиса')

  let current = start
  const seen = new Set<string>()

  for (let hop = 0; hop < maxHops; hop++) {
    const key = current.toString()
    if (seen.has(key)) throw new ShortLinkError('loop', 'Короткая ссылка ведёт по кругу')
    seen.add(key)

    const reply = await send(transport, current.toString(), userAgent, timeoutMs)

    const location = reply.location
    if (location) {
      const target = validateTarget(new URL(location, current), source.hosts)
      // Some shorteners bounce to a landing page on their own host and put the
      // real address into the query string. Deezer does exactly that.
      const embedded = embeddedTarget(target, source.hosts)
      if (embedded) {
        const settled = settledTarget(embedded)
        if (settled) return settled
        current = embedded
        continue
      }
      // The redirect already gave us the answer: do not load the service page.
      const settled = settledTarget(target)
      if (settled) return settled
      current = target
      continue
    }

    if (reply.status >= 400) {
      throw new ShortLinkError('blocked', `Сервис ответил ${reply.status}`)
    }

    // Some shorteners answer 200 and redirect with a meta tag or a canonical link.
    const html = await reply.body()
    const refresh = refreshTarget(html, current)
    if (refresh) {
      const target = validateTarget(refresh, source.hosts)
      const embedded = embeddedTarget(target, source.hosts)
      if (embedded) {
        const settled = settledTarget(embedded)
        if (settled) return settled
        current = embedded
        continue
      }
      const settled = settledTarget(target)
      if (settled) return settled
      current = target
      continue
    }
    throw new ShortLinkError('blocked', 'Сервис не сообщил полный адрес')
  }

  throw new ShortLinkError('loop', 'Слишком много переходов')
}

export function shortLinkFailureMessage(error: unknown): string {
  if (error instanceof ShortLinkError) {
    if (error.kind === 'network') {
      return 'Не удалось развернуть короткую ссылку: сервис недоступен из этой сети. Проверьте VPN или вставьте полный адрес.'
    }
    if (error.kind === 'loop') {
      return 'Короткая ссылка ведёт по кругу. Откройте её в браузере и скопируйте полный адрес.'
    }
    if (error.kind === 'blocked-host') {
      return 'Короткая ссылка ведёт на посторонний адрес. Похоже, доступ подменён провайдером или VPN. Включите VPN или вставьте полный адрес.'
    }
    if (/ответил \d{3}/.test(error.message)) {
      return `${error.message}. Ссылка устарела или сервис её не отдаёт — откройте её в браузере и скопируйте полный адрес.`
    }
    return 'Сервис не отдал полный адрес короткой ссылки. Откройте её в браузере и скопируйте адрес из строки.'
  }
  if (error instanceof Error) return error.message
  return 'Не удалось развернуть короткую ссылку.'
}

/** HEAD first: cheaper and no page load. Some services reject it, so GET is next. */
async function send(
  transport: ShortLinkTransport,
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<ShortLinkReply> {
  let reply: ShortLinkReply | null = null
  try {
    reply = await transport.send(url, { method: 'HEAD', userAgent, timeoutMs })
  } catch {
    // Fall through to GET.
  }
  if (reply && (reply.location || reply.status < 400)) return reply
  if (reply) await reply.discard()
  try {
    return await transport.send(url, { method: 'GET', userAgent, timeoutMs })
  } catch (error) {
    throw new ShortLinkError('network', error instanceof Error ? error.message : 'Запрос не выполнен')
  }
}

/**
 * Default transport for tests and non-Electron callers. Manual redirects are
 * kept so the service page is never loaded; credentials are omitted so a
 * shortener cannot see the user's cookies.
 */
export function fetchTransport(fetchImpl: typeof fetch = fetch): ShortLinkTransport {
  return {
    async send(url, { method, userAgent, timeoutMs }) {
      let response: Response
      try {
        response = await fetchImpl(url, {
          method,
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,*/*' },
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (method === 'HEAD') throw error
        throw new ShortLinkError('network', error instanceof Error ? error.message : 'Запрос не выполнен')
      }
      const location = response.headers.get('location')
      return {
        status: response.status,
        location,
        body: () => readBody(response),
        discard: async () => { await response.body?.cancel().catch(() => {}) },
      }
    },
  }
}

async function readBody(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || !value) break
      chunks.push(value)
      size += value.byteLength
      if (size >= maxSnippetBytes) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
}

function parseUrl(raw: string): URL | null {
  const text = raw.trim()
  if (!text || text.length > 2_048) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}

function validateTarget(url: URL, allowed: readonly string[]): URL {
  if (url.protocol !== 'https:') throw new ShortLinkError('blocked-host', 'Переход ведёт не на https')
  const host = normalizeHost(url.hostname)
  if (!allowed.some(domain => hostMatches(host, domain))) {
    throw new ShortLinkError('blocked-host', `Неожиданный адрес: ${host}`)
  }
  return url
}

/**
 * A full provider address, not another shortener hop. Returning the landing
 * page would only move the failure into the playlist parser, where the message
 * ("не удалось прочитать ссылку") says nothing about the real cause.
 */
function settledTarget(url: URL): string | null {
  const info = detectImportLink(url.toString())
  if (!info || info.short) return null
  return url.toString()
}

/** Query names Deezer and friends use to carry the real address. */
const embeddedTargetParams = ['awf', 'dest', 'gwf', 'iwf', 'url', 'u', 'target', 'to', 'link', 'redirect']

/**
 * Deezer answers a share link with `link.deezer.com/?awf=<target>&dest=<target>`,
 * where the playlist address is URL-encoded in the query. The landing page it
 * serves next never names the playlist, so the query is the only place the id
 * exists without loading the app.
 */
function embeddedTarget(url: URL, allowed: readonly string[]): URL | null {
  for (const name of embeddedTargetParams) {
    const parsed = decodedTarget(url.searchParams.get(name), allowed)
    if (parsed) return parsed
  }
  // Unknown wrappers: accept any parameter that already looks like a real link.
  for (const value of url.searchParams.values()) {
    const parsed = decodedTarget(value, allowed)
    if (parsed) return parsed
  }
  return null
}

function decodedTarget(raw: string | null, allowed: readonly string[]): URL | null {
  if (!raw || raw.length > 2_048 || !/^https:\/\//i.test(raw)) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  const host = normalizeHost(parsed.hostname)
  if (!allowed.some(domain => hostMatches(host, domain))) return null
  const info = detectImportLink(parsed.toString())
  if (!info || info.short) return null
  return parsed
}

function refreshTarget(html: string, base: URL): URL | null {
  if (!html) return null
  const meta = /http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"']+)["']/i.exec(html)
  const direct = meta?.[1]?.trim()
  if (direct) return safeUrl(direct, base)
  const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)
  const href = canonical?.[1]?.trim()
  if (href) return safeUrl(href, base)
  return null
}

function safeUrl(value: string, base: URL): URL | null {
  try {
    return new URL(value, base)
  } catch {
    return null
  }
}
