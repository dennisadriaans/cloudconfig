import { builtinModules } from 'node:module'
import { join } from 'node:path'
import { build } from 'esbuild'

/** Compile the actual adapters and SDK for workerd, including its Node compatibility layer. */
export async function bundleWorker(contents: string): Promise<string> {
  const bundle = await build({
    stdin: {
      resolveDir: join(import.meta.dirname, '../..'),
      sourcefile: 'fixture-worker.ts',
      loader: 'ts',
      contents,
    },
    bundle: true,
    platform: 'neutral',
    format: 'esm',
    write: false,
    conditions: ['workerd', 'worker', 'browser'],
    mainFields: ['module', 'main'],
    external: ['cloudflare:*', 'node:*'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'worker-node-builtins',
        setup(builder) {
          builder.onResolve({ filter: /^[\w/]+$/ }, ({ path }) =>
            builtinModules.includes(path) ? { path: `node:${path}`, external: true } : undefined,
          )
        },
      },
    ],
  })
  return bundle.outputFiles[0]!.text
}
