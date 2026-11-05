import { resolveConfigExport } from '@cloudconfig/core'
import { configureAutomationRequest } from '@cloudconfig/core/automations/configure'
import { defineEventHandler } from '#imports'
import * as configModule from '#cloudconfig/config'
import { platformEnv, toRequest, type H3Event } from './handler.js'

const config = resolveConfigExport(configModule, '#cloudconfig/config')
export default defineEventHandler(async (event: H3Event) =>
  configureAutomationRequest(config, await toRequest(event, true), platformEnv(event)),
)
