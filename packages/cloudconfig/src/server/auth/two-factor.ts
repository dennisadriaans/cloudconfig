/** Extend Better Auth's challenge/session machinery to social sign-in and passkeys. */
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api'
import { expireCookie, setSessionCookie } from 'better-auth/cookies'
import { twoFactor } from 'better-auth/plugins/two-factor'
import type { BetterAuthPlugin, GenericEndpointContext } from 'better-auth'
import { createEmailClient } from '@dashboardstack/email'
import type { ResolvedAuth } from '../../shared/auth-resolve.js'
import { isDevelopment, readEnv } from './env.js'

type FactorConfig = NonNullable<ResolvedAuth['twoFactor']>
type FactorUser = { id: string; twoFactorEnabled?: boolean; twoFactorMethod?: string }

function fail(message: string): never {
  throw new APIError('UNAUTHORIZED', { message })
}

async function pendingChallenge(ctx: GenericEndpointContext) {
  const cookie = ctx.context.createAuthCookie('two_factor')
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
  if (!identifier) return null
  const record = await ctx.context.internalAdapter.findVerificationValue(identifier)
  if (!record || record.expiresAt <= new Date()) return null
  const user = await ctx.context.internalAdapter.findUserById(record.value)
  return user ? { identifier, user: user as typeof user & FactorUser, cookie } : null
}

function requireFresh(session: { session: { createdAt: Date } }) {
  if (Date.now() - new Date(session.session.createdAt).getTime() > 5 * 60_000) {
    fail('Sign in again before changing your two-factor authentication settings.')
  }
}

async function sendEmail(
  config: FactorConfig,
  env: Record<string, unknown> | undefined,
  email: string,
  otp: string,
) {
  const apiKey = readEnv(config.email.apiKeyEnv, env)
  const baseUrl = readEnv(config.email.serviceUrlEnv, env)
  if (!apiKey || !baseUrl) {
    if (isDevelopment(env)) {
      console.info(`[cloudconfig:auth] Development email OTP for ${email}: ${otp}`)
      return
    }
    throw new Error(
      `Email OTP requires ${config.email.apiKeyEnv} and ${config.email.serviceUrlEnv}. Run cloudconfig auth email.`,
    )
  }
  const client = createEmailClient({
    apiKey,
    baseUrl,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
  })
  try {
    const result = await client.send({
      to: email,
      subject: 'Your verification code',
      text: `Your verification code is ${otp}. It expires in 5 minutes. If you did not request this code, you can ignore this email.`,
    })
    if (result.status !== 'sent' || (result.dryRun && !isDevelopment(env))) {
      throw new Error('Email delivery did not complete.')
    }
  } catch (cause) {
    throw new Error(
      'Could not send the verification email. Try again, or contact support if the problem continues.',
      { cause },
    )
  }
}

export async function createTwoFactorPlugins(
  config: FactorConfig,
  env: Record<string, unknown> | undefined,
): Promise<BetterAuthPlugin[]> {
  const factor = twoFactor({
    allowPasswordless: true,
    totpOptions: { disable: true },
    otpOptions: {
      period: 5,
      storeOTP: 'hashed',
      allowedAttempts: 5,
      async sendOTP({ user, otp }, ctx) {
        try {
          await sendEmail(config, env, user.email, otp)
        } catch (error) {
          // Better Auth catches delivery errors. Return an actionable failure to the caller.
          if (ctx) {
            ;(ctx.context as { cloudconfigEmailError?: string }).cloudconfigEmailError =
              error instanceof Error ? error.message : 'Could not send the verification email.'
          }
          throw error
        }
      },
    },
  })
  const credentialGate = factor.hooks.after[0]!
  const oauthCallback = (path: string) =>
    path.startsWith('/callback/') ||
    path.startsWith('/oauth2/callback/') ||
    path === '/oauth-proxy-callback'
  const signInPath = (path: string) =>
    oauthCallback(path) || path.startsWith('/sign-in/') || path.startsWith('/sign-up/')

  const guard = createAuthMiddleware(async (ctx) => {
    if (ctx.path === '/two-factor/enable' || ctx.path.includes('totp')) {
      throw new APIError('BAD_REQUEST', {
        message: 'Enable email 2FA by verifying a code, or register a passkey.',
      })
    }
    const session = await getSessionFromCtx(ctx, { disableCookieCache: true })
    const path = ctx.path
    if (path === '/two-factor/send-otp' || path === '/two-factor/verify-otp') {
      let key: string
      if (session) {
        requireFresh(session)
        key = `${session.user.id}!${session.session.id}`
      } else {
        const challenge = await pendingChallenge(ctx)
        if (!challenge || challenge.user.twoFactorMethod !== 'email') {
          fail('Sign in first and use your configured second factor.')
        }
        key = challenge.identifier
        if (path === '/two-factor/verify-otp') {
          // Keep the sign-in budget on the challenge, so resending an OTP
          // cannot reset it. Consuming the counter atomically claims an attempt.
          const identifier = `2fa-attempts-${key}`
          const counter = await ctx.context.internalAdapter.consumeVerificationValue(identifier)
          if (!counter) fail('Your verification attempt has expired. Sign in again.')
          const attempts = Number(counter.value)
          if (!Number.isInteger(attempts) || attempts < 0 || attempts >= 5) {
            await ctx.context.internalAdapter.consumeVerificationValue(key)
            expireCookie(ctx, challenge.cookie)
            throw new APIError('BAD_REQUEST', {
              message: 'Too many verification attempts. Sign in again.',
            })
          }
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: String(attempts + 1),
            expiresAt: counter.expiresAt,
          })
        }
      }
      if (path === '/two-factor/send-otp') {
        await ctx.context.internalAdapter.deleteVerificationByIdentifier(`2fa-otp-${key}`)
      }
    }
    if (
      path === '/two-factor/disable' ||
      path === '/passkey/generate-register-options' ||
      path === '/passkey/verify-registration'
    ) {
      if (!session) fail('Sign in before changing your two-factor authentication settings.')
      requireFresh(session)
    }
    if (
      path === '/passkey/generate-authenticate-options' ||
      path === '/passkey/verify-authentication'
    ) {
      if (session) requireFresh(session)
      else {
        const challenge = await pendingChallenge(ctx)
        if (!challenge || challenge.user.twoFactorMethod !== 'passkey') {
          fail('Complete your primary sign-in before using your passkey.')
        }
      }
    }
    if (path === '/passkey/delete-passkey' && session) {
      requireFresh(session)
      const keys = await ctx.context.adapter.findMany<{ id: string }>({
        model: 'passkey',
        where: [{ field: 'userId', value: session.user.id }],
      })
      if (
        session.user.twoFactorEnabled &&
        session.user.twoFactorMethod === 'passkey' &&
        keys.length === 1 &&
        String(keys[0]?.id) === String(ctx.body.id)
      ) {
        throw new APIError('BAD_REQUEST', {
          message: 'Choose email 2FA or turn off 2FA before removing your last passkey.',
        })
      }
    }
  })

  const complete = createAuthMiddleware(async (ctx) => {
    const deliveryError = (ctx.context as { cloudconfigEmailError?: string }).cloudconfigEmailError
    if (deliveryError) throw new APIError('BAD_GATEWAY', { message: deliveryError })
    if (signInPath(ctx.path)) {
      const user = ctx.context.newSession?.user as FactorUser | undefined
      const gated = (await credentialGate.handler({
        ...ctx,
        returnHeaders: true,
      } as unknown as Parameters<typeof credentialGate.handler>[0])) as { headers?: Headers }
      // A nested Better Auth middleware has its own cookie/header scope.
      for (const cookie of gated.headers?.getSetCookie() ?? []) {
        ctx.responseHeaders.append('set-cookie', cookie)
      }
      gated.headers?.forEach((value, key) => {
        if (key !== 'set-cookie') ctx.responseHeaders.set(key, value)
      })
      if (user?.twoFactorEnabled && !ctx.context.newSession) {
        if (oauthCallback(ctx.path)) {
          throw ctx.redirect(config.redirectPath)
        }
        return ctx.json({
          twoFactorRedirect: true,
          twoFactorMethods: [user.twoFactorMethod === 'passkey' ? 'passkey' : 'otp'],
        })
      }
      return
    }
    if (ctx.context.returned instanceof APIError) return
    if (ctx.path === '/passkey/generate-authenticate-options') {
      return ctx.json({
        ...(ctx.context.returned as Record<string, unknown>),
        userVerification: 'required',
      })
    }
    const current = ctx.context.newSession ?? ctx.context.session
    if (!current) return
    let method: 'email' | 'passkey' | null | undefined
    if (ctx.path === '/two-factor/verify-otp') method = 'email'
    if (
      ctx.path === '/passkey/verify-registration' ||
      ctx.path === '/passkey/verify-authentication'
    ) {
      method = 'passkey'
    }
    if (ctx.path === '/two-factor/disable') method = null
    if (method === undefined) return
    const user = await ctx.context.internalAdapter.updateUser(current.user.id, {
      twoFactorEnabled: method !== null,
      twoFactorMethod: method,
      ...(method === 'email' ? { emailVerified: true } : {}),
    })
    await setSessionCookie(ctx, { session: current.session, user })
    if (ctx.path === '/passkey/verify-authentication') {
      expireCookie(ctx, ctx.context.createAuthCookie('two_factor'))
    }
  })

  const plugin: BetterAuthPlugin = {
    ...factor,
    schema: {
      ...factor.schema,
      user: {
        fields: {
          ...factor.schema.user.fields,
          twoFactorMethod: { type: 'string' as const, required: false, input: false },
        },
      },
    },
    endpoints: {
      ...factor.endpoints,
      twoFactorStatus: createAuthEndpoint('/two-factor/status', { method: 'GET' }, async (ctx) => {
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true })
        const challenge = session ? null : await pendingChallenge(ctx)
        const user = (session?.user ?? challenge?.user) as FactorUser | undefined
        if (!user) fail('Your sign-in has expired. Sign in again to continue.')
        return ctx.json({
          enabled: user.twoFactorEnabled === true,
          method: user.twoFactorMethod ?? null,
          pending: !!challenge,
        })
      }),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            !!ctx.path && (ctx.path.startsWith('/two-factor/') || ctx.path.startsWith('/passkey/')),
          handler: guard,
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            !!ctx.path &&
            (signInPath(ctx.path) ||
              ctx.path.startsWith('/two-factor/') ||
              ctx.path.startsWith('/passkey/')),
          handler: complete,
        },
      ],
    },
  }
  if (config.passkey === false) return [plugin]
  const { passkey } = await import('@better-auth/passkey')
  return [
    plugin,
    passkey({
      ...config.passkey,
      rpName: config.passkey.rpName ?? 'CloudConfig',
      authenticatorSelection: { userVerification: 'required' },
      registration: {
        afterVerification({ verification }) {
          if (!verification.registrationInfo?.userVerified) {
            fail('Verify your identity with your device PIN or biometrics to add a passkey.')
          }
        },
      },
      authentication: {
        async afterVerification({ ctx, verification, clientData }) {
          if (!verification.authenticationInfo.userVerified) {
            fail('Verify your identity with your device PIN or biometrics to use this passkey.')
          }
          const session = await getSessionFromCtx(ctx, { disableCookieCache: true })
          const challenge = session ? null : await pendingChallenge(ctx)
          const user = session?.user ?? challenge?.user
          const key = await ctx.context.adapter.findOne<{ userId: string }>({
            model: 'passkey',
            where: [{ field: 'credentialID', value: clientData.id }],
          })
          if (!user || !key || String(key.userId) !== String(user.id)) {
            fail('Use a passkey registered to the account you just signed in with.')
          }
          if (challenge) {
            const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
              challenge.identifier,
            )
            if (!consumed || String(consumed.value) !== String(user.id)) {
              fail('Your sign-in has expired. Sign in again to continue.')
            }
          }
        },
      },
    }),
  ]
}
