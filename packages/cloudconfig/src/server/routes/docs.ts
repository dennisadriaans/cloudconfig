import { normalizeBasePath } from '../../shared/project-config.js'

/** Swagger UI backed by the same OpenAPI document at every docs entry point. */
export function renderDocsHtml(basePath: string, options: { studio?: boolean } = {}): string {
  const mount = normalizeBasePath(basePath)
  const openapiUrl = `${mount === '/' ? '' : mount}/openapi.json`
  const url = JSON.stringify(openapiUrl).replace(/</g, '\\u003c')
  const assets = 'https://unpkg.com/swagger-ui-dist@5.33.0'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>API Reference · CloudConfig</title>
    <link rel="stylesheet" href="${assets}/swagger-ui.css" />
    <style>body { margin: 0; background: #fafafa; }</style>
  </head>
  <body>
    ${
      options.studio
        ? `<div class="swagger-ui">
      <div class="wrapper" style="display:flex;justify-content:flex-end;padding-top:20px">
        <button id="cloudconfig-studio-toggle" class="btn" type="button" aria-haspopup="dialog" aria-expanded="false">Open Drizzle Studio</button>
      </div>
    </div>
    <script type="module" src="/_cloudconfig/studio/client.js"></script>`
        : ''
    }
    <div id="swagger-ui"></div>
    <noscript>Enable JavaScript to view the API reference.</noscript>
    <script src="${assets}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
    <script>
      SwaggerUIBundle({
        url: ${url},
        dom_id: '#swagger-ui',
        deepLinking: true,
        withCredentials: true,
        validatorUrl: null,
      })
    </script>
  </body>
</html>`
}
