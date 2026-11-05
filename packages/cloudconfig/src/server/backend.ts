/**
 * createBackend — the REST transport adapter. A thin Hono app that parses
 * HTTP requests, calls the transport-neutral operations core, and maps
 * `OpResult` codes to status codes and error bodies. All domain behavior
 * (validation, access, hooks, persistence) lives in `operations.ts`; a
 * different transport (gRPC, RPC) would adapt that same core, not this file.
 * The app's `.fetch(request, env)` runs on any platform; the second arg
 * carries platform bindings (e.g. Cloudflare `env`) through to the db driver.
 */
import { bodyLimit } from 'hono/body-limit'
import { storagePath } from './storage.js'
import { publicModels } from './compile/index.js'
import { Hono, type Context } from 'hono'
import type { AnyConfig } from '../index.js'
import type { ApiError } from '../shared/errors.js'
import { normalizeBasePath } from '../shared/project-config.js'
import { createAuthRuntime } from './auth/mount.js'
import { connectApp } from '../connect/routes.js'
import { compileConfig, type CompiledBase } from './compile/index.js'
import type { ObjectStoreProvider } from './object-store.js'
import type { DbProvider } from './driver.js'
import { ListQueryError, parseAggregateParams, parseListParams } from './list-query.js'
import {
  createOperations,
  type OpResult,
  type RequestContext,
  type ValidationIssue,
} from './operations.js'
import type { DataProvider, GetUser } from './ports.js'
import { renderDocsHtml } from './routes/docs.js'
import { buildOpenApiDocument, type OpenApiDocument } from './openapi.js'

export interface BackendOptions<TUser = unknown> {
  /** Full custom data stack (any engine, any ORM). Takes precedence over `db`. */
  data?: DataProvider
  /** Byte storage, independent of the database and application host. */
  storage?: ObjectStoreProvider
  /** A connection-level SQLite driver from `cloudconfig/drivers/*`. */
  db?: DbProvider
  getUser?: GetUser<TUser>
  basePath?: string
}

interface Env {
  Variables: { user: unknown }
  Bindings: Record<string, unknown>
}

function json(error: string, message: string, issues?: ApiError['issues']): ApiError {
  return { error, message, ...(issues ? { issues } : {}) }
}

export function createBackend<C extends AnyConfig>(
  config: C,
  opts: BackendOptions = {},
): Hono<Env> {
  // Auth is resolved before the operations core so it can fill in `getUser`:
  // with an `auth` block, access rules see a real signed-in user by default.
  // An explicit `getUser` still wins — that seam stays swappable.
  const compiled = compileConfig(config)
  const basePath = normalizeBasePath(opts.basePath ?? compiled.basePath)
  const docsBase: CompiledBase = {
    ...compiled,
    basePath,
    ...(compiled.auth
      ? {
          auth: {
            ...compiled.auth,
            basePath: rebase(compiled.auth.basePath, compiled.basePath, basePath),
          },
        }
      : {}),
  }
  const auth = docsBase.auth
    ? createAuthRuntime(compiled, docsBase.auth, opts.db ? { db: opts.db } : {})
    : undefined
  const getUser = opts.getUser ?? auth?.getUser

  const ops = createOperations(config, {
    ...(opts.data ? { data: opts.data } : {}),
    ...(opts.storage ? { storage: opts.storage } : {}),
    ...(opts.db ? { db: opts.db } : {}),
    ...(getUser ? { getUser } : {}),
  })
  const base = ops.base
  const app = new Hono<Env>()
  const isDev = (globalThis.process?.env?.['NODE_ENV'] ?? 'development') !== 'production'

  const ctxOf = (c: Context<Env>): RequestContext => ({ request: c.req.raw, env: c.env })

  /** Map a failed OpResult to the REST status code and error body. */
  function sendError(
    c: Context<Env>,
    result: { code: string; issues?: ValidationIssue[]; reason?: string },
    forbiddenMessage: string,
  ) {
    // In development, a denial caused by a *missing* rule is almost always a
    // setup mistake rather than a policy decision — name it.
    const denialHint =
      isDev && result.reason === 'no_rule'
        ? ` No access rule is set for this action and access defaults to deny.`
        : ''
    switch (result.code) {
      case 'unknown_model':
        return c.json(json('Not found', 'Unknown resource'), 404)
      case 'invalid_id':
        return c.json(json('Bad request', 'Invalid id'), 400)
      case 'validation':
        return c.json(json('Validation failed', 'Invalid input', result.issues), 400)
      case 'conflict':
        return c.json(
          json('Conflict', 'This record changed while saving. Reload it and try again.'),
          409,
        )
      case 'forbidden':
        return c.json(json('Forbidden', `${forbiddenMessage}${denialHint}`), 403)
      case 'payload_too_large':
        return c.json(
          json(
            'File too large',
            result.issues?.[0]?.message ?? 'This file exceeds the upload limit.',
            result.issues,
          ),
          413,
        )
      case 'unsupported_media_type':
        return c.json(
          json(
            'Unsupported file type',
            result.issues?.[0]?.message ?? 'This file type is not allowed.',
            result.issues,
          ),
          415,
        )
      case 'storage_failed':
        return c.json(
          json('Storage error', result.issues?.[0]?.message ?? 'File storage failed. Try again.'),
          503,
        )
      case 'write_failed':
        return c.json(json('Error', 'Failed to create record'), 500)
      case 'not_found':
      default:
        return c.json(json('Not found', `Not found${denialHint}`), 404)
    }
  }

  // Auth routes go on before the CRUD router: `/api/auth/sign-in` would
  // otherwise match `/:model/:id` and answer "invalid id".
  auth?.mount(app)
  if (compiled.connect) {
    const connectPath = rebase(compiled.connect.basePath, compiled.basePath, basePath)
    app.route(
      connectPath,
      connectApp(compiled, {
        ...(opts.db ? { db: opts.db } : {}),
        ...(getUser ? { getUser } : {}),
      }),
    )
  }

  const api = new Hono<Env>()

  if (base.docs) {
    const docsHtml = renderDocsHtml(basePath)
    api.get('/_docs', (c) => c.html(docsHtml))
    // A fallback lets applications register their own homepage after createBackend.
    app.notFound((c) => {
      if (c.req.path === '/' && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
        return c.html(docsHtml)
      }
      return c.text('404 Not Found', 404)
    })
    let openapi: OpenApiDocument | undefined
    api.get('/openapi.json', (c) => {
      openapi ??= buildOpenApiDocument(docsBase, { sessionAuth: !!auth && !opts.getUser })
      return c.json(openapi)
    })
  }

  for (const model of publicModels(base)) {
    if (!model.model.options.storage) continue
    const path = storagePath(model)
    const limit = bodyLimit({
      maxSize: (model.model.options.storage.maxSize ?? 25 * 1024 * 1024) + 1024 * 1024,
      onError: (c) => c.json(json('File too large', 'This upload exceeds the size limit.'), 413),
    })
    const upload = async (c: Context<Env>) => {
      const ctx = ctxOf(c)
      ctx.user = getUser ? await getUser(ctx.request, { env: ctx.env }) : null
      if (!ctx.user) return sendError(c, { code: 'forbidden' }, 'Sign in to upload a file')
      let form: FormData
      try {
        form = await c.req.formData()
      } catch {
        return c.json(json('Invalid upload', 'Send multipart/form-data with a file.'), 400)
      }
      let fields: Record<string, unknown> = {}
      try {
        const encoded = form.get('fields')
        if (typeof encoded === 'string') fields = JSON.parse(encoded) as Record<string, unknown>
        else {
          form.forEach((value, key) => {
            if (key !== 'file' && typeof value === 'string') fields[key] = value
          })
        }
      } catch {
        return c.json(json('Invalid upload', 'File metadata must be valid JSON.'), 400)
      }
      const result = await ops.upload(ctx, model.namePlural, { file: form.get('file'), fields })
      if (!result.ok) return sendError(c, result, 'Not allowed to upload')
      return c.json(result.value, 201)
    }
    api.post(path, limit, upload)
    api.post(`/${model.namePlural}`, limit, upload)
    api.get(`${path}/:id`, async (c) => {
      const result = await ops.download(ctxOf(c), model.namePlural, c.req.param('id'))
      if (!result.ok) return sendError(c, result, 'Not allowed to download')
      const { body, mimeType, name, size } = result.value
      return new Response(body as BodyInit, {
        headers: {
          'content-type': mimeType,
          'content-length': String(size),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      })
    })
    api.delete(`${path}/:id`, async (c) => {
      const result = await ops.remove(ctxOf(c), model.namePlural, c.req.param('id'))
      if (!result.ok) return sendError(c, result, 'Not allowed to delete')
      return c.body(null, 204)
    })
  }

  api.get('/:model', async (c) => {
    const result = await ops.list(
      ctxOf(c),
      c.req.param('model'),
      parseListParams(new URL(c.req.url)),
    )
    if (!result.ok) return sendError(c, result, 'Not allowed to list this resource')
    return c.json(result.value)
  })

  api.get('/:model/aggregate', async (c) => {
    const result = await ops.aggregate(
      ctxOf(c),
      c.req.param('model'),
      parseAggregateParams(new URL(c.req.url)),
    )
    if (!result.ok) return sendError(c, result, 'Not allowed to aggregate this resource')
    return c.json(result.value)
  })

  api.get('/:model/:id', async (c) => {
    const result = await ops.get(ctxOf(c), c.req.param('model'), c.req.param('id'))
    if (!result.ok) return sendError(c, result, 'Not allowed')
    return c.json(result.value)
  })

  api.post('/:model', async (c) => {
    const result = await ops.create(ctxOf(c), c.req.param('model'), await readJson(c.req.raw))
    if (!result.ok) return sendError(c, result, 'Not allowed to create')
    return c.json(result.value, 201)
  })

  const handleUpdate = async (c: Context<Env>) => {
    const result = await ops.update(
      ctxOf(c),
      c.req.param('model') ?? '',
      c.req.param('id'),
      await readJson(c.req.raw),
    )
    if (!result.ok) return sendError(c, result, 'Not allowed')
    return c.json(result.value)
  }
  api.put('/:model/:id', handleUpdate)
  api.patch('/:model/:id', handleUpdate)

  api.delete('/:model/:id', async (c) => {
    const result: OpResult<null> = await ops.remove(
      ctxOf(c),
      c.req.param('model'),
      c.req.param('id'),
    )
    if (!result.ok) return sendError(c, result, 'Not allowed')
    return c.body(null, 204)
  })

  app.route(basePath, api)

  app.onError((err, c) => {
    if (err instanceof ListQueryError) return c.json(json('Bad request', err.message), 400)
    console.error('[cloudconfig] Unhandled request error:', err)
    const message = isDev && err instanceof Error ? err.message : 'Internal server error'
    return c.json(json('Database error', message), 500)
  })

  return app
}

/**
 * Follow a `basePath` override with the auth path. A host that mounts the
 * backend somewhere other than the config says (the `basePath` option) would
 * otherwise register the auth routes at a path nothing reaches.
 */
function rebase(authPath: string, configBase: string, override: string): string {
  if (override === configBase) return authPath
  if (configBase !== '/' && !authPath.startsWith(`${configBase}/`)) return authPath
  const suffix = configBase === '/' ? authPath : authPath.slice(configBase.length)
  return `${override === '/' ? '' : override}${suffix}`
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

// re-export for consumers wiring their own driver
export type { CompiledBase }
