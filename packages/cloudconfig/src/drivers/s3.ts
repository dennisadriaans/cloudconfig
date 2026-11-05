import { AwsClient } from 'aws4fetch'
import type { ObjectStore } from '../server/object-store.js'

export interface S3Options {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region?: string
}

/** S3-compatible byte storage, including Cloudflare R2. Credentials stay on the server. */
export function s3Store(options: S3Options): ObjectStore {
  const client = new AwsClient({ ...options, service: 's3', region: options.region ?? 'auto' })
  const endpoint = new URL(options.endpoint)
  if (endpoint.protocol !== 'https:') throw new Error('S3 endpoint must use HTTPS.')
  function url(key = ''): URL {
    const path = [options.bucket, ...key.split('/')].map(encodeURIComponent).join('/')
    return new URL(`${endpoint.pathname.replace(/\/$/, '')}/${path}`, endpoint.origin)
  }
  async function send(target: URL, init: RequestInit = {}): Promise<Response> {
    const response = await client.fetch(target, { ...init, signal: AbortSignal.timeout(30_000) })
    if (!response.ok && response.status !== 404) {
      throw new Error(`Object storage request failed (${response.status}).`)
    }
    return response
  }
  return {
    async put(key, bytes, mimeType) {
      const response = await send(url(key), {
        method: 'PUT',
        body: new Uint8Array(bytes),
        headers: { 'Content-Type': mimeType },
      })
      if (!response.ok) throw new Error('Object storage bucket was not found.')
    },
    async get(key) {
      const response = await send(url(key))
      return response.status === 404 ? null : response.body
    },
    async delete(key) {
      await send(url(key), { method: 'DELETE' })
    },
    async list(prefix) {
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const target = url()
        target.searchParams.set('list-type', '2')
        target.searchParams.set('encoding-type', 'url')
        target.searchParams.set('prefix', prefix)
        if (cursor) target.searchParams.set('continuation-token', cursor)
        const response = await send(target)
        if (!response.ok) throw new Error('Object storage bucket was not found.')
        const xml = await response.text()
        if (!/<ListBucketResult(?:\s|>)/.test(xml)) {
          throw new Error('Object storage returned an invalid listing.')
        }
        // Request URL-encoded keys so XML entity handling cannot change an object key.
        const matches = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)]
        keys.push(...matches.map((match) => decodeURIComponent(decodeXml(match[1] ?? ''))))
        const previousCursor = cursor
        cursor = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
        if (cursor) cursor = decodeXml(cursor)
        if (cursor && cursor === previousCursor) {
          throw new Error('Object storage repeated its continuation token.')
        }
        if (/<IsTruncated>true<\/IsTruncated>/.test(xml) && !cursor) {
          throw new Error('Object storage returned a truncated page without a continuation token.')
        }
      } while (cursor)
      return keys
    },
  }
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => {
    const entities: Record<string, string> = {
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    }
    return entities[entity] ?? entity
  })
}
