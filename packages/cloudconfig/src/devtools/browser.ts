import { mountStudioToolbar } from './client.js'

mountStudioToolbar(
  new URL('./', import.meta.url).pathname.replace(/\/$/, ''),
  document.querySelector<HTMLButtonElement>('#cloudconfig-studio-toggle') ?? undefined,
)
