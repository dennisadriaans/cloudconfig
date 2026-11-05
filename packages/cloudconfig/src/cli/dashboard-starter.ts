/** Real sign-in accounts, managed through the explicit auth capability. */
export const DASHBOARD_STARTER_CONFIG = `import { defineBackend } from '@cloudconfig/core'
// import { model, t } from '@cloudconfig/core'

// Define your data and access rules here; CloudConfig creates the API and typed client.
// Get started from this folder (commands use pnpm):
//   pnpm install      # first time only
//   pnpm db:generate  # create SQL migrations from this config
//   pnpm db:migrate   # apply migrations to the local database
//   pnpm dev          # start Nuxt or the standalone API
// After model/field changes, repeat generate + migrate, then restart pnpm dev.
// Try the API at /api/_docs on your dev server.
// Models, fields and access rules: https://cloudconfig.dev/docs/configuration

export const config = defineBackend({
  models: {
    // To add posts, uncomment the model/t import above and the post block below,
    // then run generate + migrate and restart dev as described above.
    // The singular key "post" creates the posts table and /api/posts routes.
    // id, createdAt and updatedAt are automatic. Missing access rules deny access.
    // post: model(
    //   {
    //     title: t.text().required(),
    //     body: t.textarea(),
    //     published: t.boolean().default(false),
    //   },
    //   {
    //     access: {
    //       // Anyone can read published posts; drafts stay hidden.
    //       list: ({ where }) => where('published', 'eq', true),
    //       read: ({ where }) => where('published', 'eq', true),
    //       // Any signed-in user can create, update or delete any post.
    //       create: ({ user }) => user != null,
    //       update: ({ user }) => user != null,
    //       delete: ({ user }) => user != null,
    //     },
    //   },
    // ),
  },

  // Set up GitHub sign-in: pnpm exec cloudconfig auth add github
  // Guide: https://cloudconfig.dev/docs/authentication
  auth: {
    providers: { github: true },
    devIdp: false, // Use real GitHub sign-in even during local development.
    proxy: false,
    organizations: true,
    twoFactor: true, // Users choose email OTP or a passkey in account settings.
    // Add an existing account ID to bootstrap access; admins and superusers also qualify.
    admin: { userIds: [], adminRoles: ['admin', 'superuser'] },
  },
  server: { basePath: '/api', docs: true },

  // Optional deployment settings (e.g. domain): https://cloudconfig.dev/docs/deployment
  deploy: {},
})
`
