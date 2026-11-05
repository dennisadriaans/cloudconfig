/** Shared by Nuxt and the standalone server; no frontend framework is required. */
export function mountStudioToolbar(endpoint: string, trigger?: HTMLButtonElement): () => void {
  if (document.getElementById('cloudconfig-studio')) return () => {}
  const host = document.createElement('div')
  host.id = 'cloudconfig-studio'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <style>
      :host { color-scheme: light dark; font: 13px/1.5 var(--font-sans, ui-sans-serif, system-ui, sans-serif); }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, a { color: inherit; font: inherit; }
      button { cursor: pointer; }
      button:focus-visible, a:focus-visible, section:focus-visible { outline: 2px solid var(--ui-text, #71717a); outline-offset: 3px; }
      button { background: none; border: 0; border-radius: 6px; padding: 6px 9px; }
      button:hover, a:hover { background: var(--ui-bg-elevated, light-dark(#f4f4f5, #27272a)); }
      .toggle { position: fixed; z-index: 2147483001; bottom: max(12px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%);
        display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border-radius: 50%;
        color: var(--ui-text-muted, light-dark(#71717a, #a1a1aa)); background: var(--ui-bg, light-dark(#fff, #18181b));
        border: 1px solid var(--ui-border, light-dark(#e4e4e7, #3f3f46)); box-shadow: 0 1px 4px #00000014; }
      svg { width: 16px; height: 16px; }
      section { position: fixed; z-index: 2147483000; left: 16px; right: 16px; bottom: calc(64px + env(safe-area-inset-bottom));
        height: min(75dvh, 900px); display: flex; flex-direction: column; overflow: hidden; border-radius: 12px;
        color: var(--ui-text, light-dark(#18181b, #f4f4f5)); background: var(--ui-bg, light-dark(#fff, #18181b));
        border: 1px solid var(--ui-border, light-dark(#e4e4e7, #3f3f46)); box-shadow: 0 12px 40px #00000024; }
      header { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
      .heading { flex: 1; min-width: 0; } h2 { margin: 0; font-size: 14px; font-weight: 600; }
      p { margin: 0; } .muted { color: var(--ui-text-muted, light-dark(#71717a, #a1a1aa)); font-size: 12px; }
      a { border-radius: 6px; padding: 6px 9px; text-decoration: none; }
      .status { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
      .retry { border: 1px solid var(--ui-border, light-dark(#e4e4e7, #3f3f46)); }
      iframe { flex: 1; min-height: 0; width: 100%; border: 0; background: white; }
      @media (max-width: 640px) { section { left: 8px; right: 8px; } }
    </style>
    <button class="toggle" type="button" aria-label="Open Drizzle Studio" title="Open Drizzle Studio" aria-expanded="false" aria-controls="panel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>
      </svg>
    </button>
    <section id="panel" role="dialog" aria-modal="false" aria-labelledby="title" tabindex="-1" hidden>
      <header><div class="heading"><h2 id="title">Drizzle Studio</h2><p class="muted">Local development database</p></div>
        <a target="_blank" rel="noopener noreferrer" hidden>Open in new tab</a>
        <button class="close" type="button" aria-label="Close Drizzle Studio" title="Close Drizzle Studio">✕</button>
      </header>
      <div class="status"><p role="status" aria-live="polite"></p><button class="retry" type="button" hidden>Retry</button></div>
      <iframe title="Drizzle Studio — local development database" allow="local-network-access; loopback-network" hidden></iframe>
    </section>`

  // All selectors refer to the static, package-owned markup above.
  const toolbarToggle = root.querySelector<HTMLButtonElement>('.toggle')!
  const toggle = trigger ?? toolbarToggle
  const panel = root.querySelector<HTMLElement>('section')!
  if (trigger) {
    toolbarToggle.hidden = true
    panel.style.bottom = 'max(16px, env(safe-area-inset-bottom))'
  }
  const close = root.querySelector<HTMLButtonElement>('.close')!
  const link = root.querySelector<HTMLAnchorElement>('a')!
  const status = root.querySelector<HTMLElement>('.status')!
  const message = root.querySelector<HTMLElement>('[role="status"]')!
  const retry = root.querySelector<HTMLButtonElement>('.retry')!
  const frame = root.querySelector<HTMLIFrameElement>('iframe')!
  let pending: AbortController | undefined
  let disposed = false
  let connected = ''

  async function connect() {
    if (pending || disposed) return
    pending = new AbortController()
    status.hidden = false
    retry.hidden = true
    message.textContent = 'Connecting to your database…'
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'X-CloudConfig-Studio': 'open' },
        signal: pending.signal,
      })
      const result = (await response.json()) as { url?: string; message?: string }
      if (!response.ok || !result.url) {
        throw new Error(result.message ?? 'Could not connect to Studio.')
      }
      const url = new URL(result.url)
      if (url.origin !== 'https://local.drizzle.studio') {
        throw new Error('Unexpected Studio address.')
      }
      if (disposed) return
      link.href = url.href
      link.hidden = false
      if (connected !== url.href) frame.src = url.href
      connected = url.href
      frame.hidden = false
      status.hidden = true
    } catch (error) {
      if (disposed) return
      message.textContent =
        error instanceof Error
          ? error.message
          : 'Could not connect to Studio. Retry or check the dev server terminal.'
      retry.hidden = false
      frame.hidden = true
      link.hidden = true
    } finally {
      pending = undefined
    }
  }

  function setOpen(open: boolean) {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    const label = open ? 'Close Drizzle Studio' : 'Open Drizzle Studio'
    toggle.setAttribute('aria-label', label)
    toggle.title = label
    if (trigger) toggle.textContent = label
    if (open) {
      panel.focus()
      void connect()
    } else toggle.focus()
  }

  const onToggle = () => setOpen(panel.hidden)
  toggle.addEventListener('click', onToggle)
  close.addEventListener('click', () => setOpen(false))
  retry.addEventListener('click', () => {
    void connect()
  })
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !panel.hidden) {
      event.preventDefault()
      setOpen(false)
    }
  }
  document.addEventListener('keydown', onKeydown)
  document.body.append(host)

  return () => {
    disposed = true
    pending?.abort()
    toggle.removeEventListener('click', onToggle)
    document.removeEventListener('keydown', onKeydown)
    host.remove()
  }
}
