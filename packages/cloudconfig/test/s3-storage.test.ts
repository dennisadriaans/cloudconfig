import { afterEach, expect, it, vi } from 'vitest'
import { s3Store } from '../src/drivers/s3.js'

afterEach(() => vi.unstubAllGlobals())

function store() {
  return s3Store({
    endpoint: 'https://account.r2.cloudflarestorage.com',
    bucket: 'notes-files',
    accessKeyId: 'access-id',
    secretAccessKey: 'secret-key',
  })
}

it('signs private R2-compatible requests and preserves keys and bytes', async () => {
  const calls: Request[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      calls.push(request.clone())
      return new Response(request.method === 'GET' ? 'file-content' : '', { status: 200 })
    }),
  )
  const bytes = new TextEncoder().encode('file-content')
  await store().put('1/notes & drafts.txt', bytes, 'text/plain')
  const downloaded = await store().get('1/notes & drafts.txt')
  const content =
    downloaded instanceof Uint8Array
      ? new TextDecoder().decode(downloaded)
      : await new Response(downloaded).text()
  expect(content).toBe('file-content')
  expect(await calls[0]!.text()).toBe('file-content')
  expect(calls[0]!.headers.get('Authorization')).toContain('AWS4-HMAC-SHA256')
  expect(calls[0]!.url).toBe(
    'https://account.r2.cloudflarestorage.com/notes-files/1/notes%20%26%20drafts.txt',
  )
  expect(calls[0]!.headers.get('Content-Type')).toBe('text/plain')
})

it('handles paginated listings and URL-encoded object keys', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: Request) => {
      const url = new URL(request.url)
      expect(url.searchParams.get('encoding-type')).toBe('url')
      const second = url.searchParams.has('continuation-token')
      return new Response(
        second
          ? '<ListBucketResult><Contents><Key>1%2Fsecond.txt</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'
          : '<ListBucketResult><Contents><Key>1%2Fnotes%20%26%20drafts.txt</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next&amp;page</NextContinuationToken></ListBucketResult>',
      )
    }),
  )
  expect(await store().list('1/')).toEqual(['1/notes & drafts.txt', '1/second.txt'])
})

it('returns null for a missing object and surfaces authorization failures', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  expect(await store().get('missing')).toBeNull()
  fetch.mockImplementation(async () => new Response('', { status: 403 }))
  await expect(store().get('private')).rejects.toThrow('403')
})
