import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { YandexCoverProxy } from '../src/main/yandex-cover'

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url))
const serve = (proxy: YandexCoverProxy, id: string, method = 'GET') =>
  proxy.serve(new Request(`mustplay://app/yandex-cover/${id}`, { method }), id)

it('serves validated cover bytes with safe headers and caches the fetch', async () => {
  const jpg = await fixture('cover.jpg')
  const fetchCover = vi.fn(async () => jpg)
  const proxy = new YandexCoverProxy(fetchCover)
  proxy.register('123', 'avatars.yandex.net/get-music/%%/cover')
  const get = await serve(proxy, '123')
  const head = await serve(proxy, '123', 'HEAD')
  expect(fetchCover).toHaveBeenCalledTimes(1)
  expect(get.status).toBe(200)
  expect(get.headers.get('Content-Type')).toBe('image/jpeg')
  expect(get.headers.get('X-Content-Type-Options')).toBe('nosniff')
  expect(get.headers.get('Cache-Control')).toBe('no-store')
  expect(Buffer.from(await get.arrayBuffer())).toEqual(jpg)
  expect(head.body).toBeNull()
  expect(head.headers.get('Content-Length')).toBe(String(jpg.length))
})

it('returns 404 for unknown tracks and unsupported images', async () => {
  const proxy = new YandexCoverProxy(async () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
  expect((await serve(proxy, '999')).status).toBe(404)
  proxy.register('123', 'avatars.yandex.net/get-music/%%/cover')
  expect((await serve(proxy, '123')).status).toBe(404)
})