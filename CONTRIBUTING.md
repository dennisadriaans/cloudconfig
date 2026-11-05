# Contributing

Thanks for helping improve CloudConfig. Bug reports, fixes and documentation
changes are welcome.

## Setup

You need Node.js 22.12 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm build
```

| Path                   | Contents                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `packages/cloudconfig` | `@cloudconfig/core`: DSL, server, client, MCP, deploy and CLI |
| `packages/nuxt`        | `@cloudconfig/nuxt`: the Nuxt module                         |

## Checks

Run these before you open a pull request. CI runs the same commands.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

## Report a Bug

Search [existing issues](https://github.com/dennisadriaans/cloudconfig/issues)
before opening a report. Use the bug report form and include:

- The installed CloudConfig package versions.
- Your Node.js version, framework, and deployment platform.
- Steps to reproduce, the expected behavior, and what happened instead.
- A small reproduction or relevant logs with credentials removed.

## Suggest a Feature

Use the feature request form to describe the problem you want to solve, your
proposed behavior, and any workaround you currently use. Reactions on an existing
request help show interest without opening duplicate issues.

## Pull Requests

- Keep changes focused, and add or update a test for every behavior change.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages.
- Report security issues privately through GitHub security advisories, not public issues.
