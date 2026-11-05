/**
 * `cloudconfig/drivers/d1` — Cloudflare D1 driver. Reads the named binding off the
 * per-request platform env.
 */
import { drizzle } from 'drizzle-orm/d1'
import type { Db, DbProvider } from '../server/driver.js'

export function d1(bindingName = 'DB'): DbProvider {
  return {
    id: 'd1',
    connect({ env }): Db {
      const binding = env?.[bindingName]
      if (!binding) {
        throw new Error(`D1 binding "${bindingName}" not found on platform env.`)
      }
      return drizzle(binding)
    },
  }
}
