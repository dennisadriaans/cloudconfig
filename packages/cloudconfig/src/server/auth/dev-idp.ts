/**
 * The development identity provider — a fake OAuth server so `sign in with
 * Google` works before anyone has a Google project.
 *
 * This is the piece that makes CloudConfig's sign-in feel hosted without CloudConfig
 * hosting anything: Clerk gets the same effect by handing every development
 * instance a set of shared OAuth credentials, which means a third party's
 * client secret sitting in your app. Here nothing is shared and nothing leaves
 * the process — the "provider" is one HTML account picker plus two in-memory
 * callbacks wired into better-auth's genericOAuth plugin, so there is no token
 * endpoint, no userinfo endpoint and no network hop to fake.
 *
 * It is mounted ONLY when the environment positively identifies itself as
 * development (see `isDevelopment`), and every request re-checks that before
 * answering. An unknown environment counts as production.
 */
import { Hono } from 'hono'
import type { DevIdpUser } from '../../dsl/auth-config.js'
import { DEV_IDP_PROVIDER_ID, DEV_IDP_SEGMENT } from '../../shared/auth-resolve.js'
import { isDevelopment } from './env.js'

export { DEV_IDP_SEGMENT }

const GRANT_TTL_MS = 5 * 60 * 1000

interface Grant {
  email: string
  name: string
  image?: string
  expiresAt: number
  /** An authorization code is single-use, even a pretend one. */
  redeemed?: boolean
}

const grants = new Map<string, Grant>()

function sweep(): void {
  const now = Date.now()
  for (const [code, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(code)
  }
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function page(redirectUri: string, state: string, users: readonly DevIdpUser[]): string {
  const rows = users
    .map(
      (user) => `<button class="row" name="email" value="${esc(user.email)}" type="submit">
  <strong>${esc(user.name ?? user.email)}</strong><span>${esc(user.email)}</span>
</button>`,
    )
    .join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CloudConfig development sign-in</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f7}
@media (prefers-color-scheme:dark){body{background:#111}}
.card{width:min(420px,92vw);background:Canvas;border:1px solid #8883;border-radius:14px;padding:1.5rem}
h1{font-size:1.05rem;margin:0 0 .25rem}
p.sub{margin:0 0 1.25rem;opacity:.7;font-size:.85rem}
.row{display:flex;flex-direction:column;align-items:flex-start;gap:.1rem;width:100%;padding:.7rem .9rem;margin-bottom:.5rem;
  border:1px solid #8883;border-radius:10px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.row:hover{border-color:#8886;background:#8881}
.row span{font-size:.8rem;opacity:.65}
hr{border:0;border-top:1px solid #8883;margin:1.1rem 0}
label{display:block;font-size:.8rem;opacity:.7;margin-bottom:.35rem}
input{width:100%;padding:.6rem .7rem;border:1px solid #8884;border-radius:10px;background:transparent;color:inherit;font:inherit}
button.go{margin-top:.6rem;width:100%;padding:.6rem;border:0;border-radius:10px;background:#3b82f6;color:#fff;font:inherit;cursor:pointer}
footer{margin-top:1.25rem;font-size:.75rem;opacity:.55;text-align:center}
</style></head><body>
<form class="card" method="post">
  <h1>Development sign-in</h1>
  <p class="sub">CloudConfig's local identity provider. No real provider is contacted.</p>
  <input type="hidden" name="redirect_uri" value="${esc(redirectUri)}">
  <input type="hidden" name="state" value="${esc(state)}">
  ${rows}
  <hr>
  <label for="custom">Or sign in as someone else</label>
  <input id="custom" name="email" type="email" placeholder="you@example.com" autocomplete="off">
  <button class="go" type="submit">Continue</button>
  <footer>Never served when NODE_ENV is production.</footer>
</form>
</body></html>`
}

/**
 * Same-origin only. The picker is a redirector, and even a development-only one
 * should not be able to bounce a browser to an arbitrary host.
 */
function isSameOrigin(target: string, requestUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(requestUrl).origin
  } catch {
    return false
  }
}

type DevEnv = { Bindings: Record<string, unknown> }

/** The account picker, as a Hono app to mount under `<authBasePath>/dev-idp`. */
export function devIdpApp(users: readonly DevIdpUser[]): Hono<DevEnv> {
  const app = new Hono<DevEnv>()

  app.get('/authorize', (c) => {
    if (!isDevelopment(c.env)) return c.text('Not found', 404)
    const url = new URL(c.req.url)
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const state = url.searchParams.get('state') ?? ''
    if (!redirectUri || !isSameOrigin(redirectUri, c.req.url)) {
      return c.text('Invalid redirect_uri for the development identity provider.', 400)
    }
    return c.html(page(redirectUri, state, users))
  })

  app.post('/authorize', async (c) => {
    if (!isDevelopment(c.env)) return c.text('Not found', 404)
    const form = await c.req.formData()
    const redirectUri = String(form.get('redirect_uri') ?? '')
    const state = String(form.get('state') ?? '')
    // The seeded buttons and the free-text field share the name, so the last
    // non-empty value wins: a typed address overrides the button that submitted.
    const email = form
      .getAll('email')
      .map((value) => String(value).trim())
      .filter(Boolean)
      .pop()

    if (!redirectUri || !isSameOrigin(redirectUri, c.req.url)) {
      return c.text('Invalid redirect_uri for the development identity provider.', 400)
    }
    if (!email) return c.text('Pick an account or type an email address.', 400)

    sweep()
    const code = crypto.randomUUID()
    const seeded = users.find((user) => user.email === email)
    grants.set(code, {
      email,
      name: seeded?.name ?? email.split('@')[0] ?? email,
      ...(seeded?.image ? { image: seeded.image } : {}),
      expiresAt: Date.now() + GRANT_TTL_MS,
    })

    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (state) target.searchParams.set('state', state)
    return c.redirect(target.toString(), 302)
  })

  return app
}

/**
 * The genericOAuth provider entry. `getToken` and `getUserInfo` resolve the
 * grant in memory, so the only endpoint that has to exist over HTTP is the
 * account picker above.
 */
export function devIdpProviderConfig(authorizeUrl: string): Record<string, unknown> {
  return {
    providerId: DEV_IDP_PROVIDER_ID,
    clientId: 'cloudconfig-dev-idp',
    clientSecret: 'cloudconfig-dev-idp',
    authorizationUrl: authorizeUrl,
    // genericOAuth validates this URL even when getToken handles the exchange in memory.
    tokenUrl: new URL('token', authorizeUrl).href,
    scopes: ['openid', 'email', 'profile'],
    pkce: false,
    getToken: (data: { code: string }) => {
      const grant = grants.get(data.code)
      if (!grant || grant.redeemed || grant.expiresAt <= Date.now()) {
        throw new Error('The development sign-in code expired. Start the sign-in again.')
      }
      grant.redeemed = true
      return Promise.resolve({
        accessToken: data.code,
        tokenType: 'Bearer',
        accessTokenExpiresAt: new Date(grant.expiresAt),
        scopes: ['openid', 'email', 'profile'],
      })
    },
    getUserInfo: (tokens: { accessToken?: string }) => {
      const code = tokens.accessToken ?? ''
      // Not deleted here: the code was already spent in `getToken`, and a
      // second profile read during the same sign-in must not fail.
      const grant = grants.get(code)
      if (!grant) return Promise.resolve(null)
      return Promise.resolve({
        id: grant.email,
        email: grant.email,
        name: grant.name,
        emailVerified: true,
        ...(grant.image ? { image: grant.image } : {}),
      })
    },
  }
}
