import {
  createAccountClient,
  createAdminClient,
  createClient,
  createFilters,
  createOrganizationClient,
  createTable,
  type AdminUser,
} from '../src/client/index.js'
import { defineBackend, model, t } from '../src/index.js'

function tableTypeContract() {
  const config = defineBackend({
    models: { post: model({ title: t.text().required(), published: t.boolean().default(false) }) },
  })
  const posts = createTable(createClient<typeof config>().post)
  // @ts-expect-error Initial options cannot widen the model's valid sort fields.
  createTable(createClient<typeof config>().post, { sortBy: 'missing' })
  void posts.create({ title: 'Hello' })
  void posts.setSort('title')
  // @ts-expect-error Required model input is preserved through the controller.
  void posts.create({})
  // @ts-expect-error Unknown model fields are not sortable.
  void posts.setSort('missing')
  // @ts-expect-error Update fields stay typed.
  void posts.update(1, { published: 'yes' })

  const admin = createAdminClient()
  const users = createTable(admin)
  void users.create({ name: 'Ada', email: 'ada@example.com' })
  void users.update(1, { name: 'Ada Lovelace' })
  void users.update(1, { role: 'admin' })
  void users.update(1, { email: 'new@example.com' })
  void admin.setUserPassword(1, 'a-secure-password')
  void admin.banUser(1, { reason: 'Abuse', expiresIn: 3600 })
  const filters = createFilters<AdminUser>()
  void users.setFilters(filters.and(filters.where('emailVerified', 'eq', true)))
  // @ts-expect-error Boolean fields require boolean values.
  filters.where('emailVerified', 'eq', 'true')
  // @ts-expect-error Boolean fields do not support text operations.
  filters.where('emailVerified', 'like', 'true')
  // @ts-expect-error Unknown fields cannot be filtered.
  filters.where('password', 'eq', 'secret')

  const account = createAccountClient()
  void account.updateUser({ name: 'Ada Lovelace' })
  void account.deleteUser()

  const organizations = createOrganizationClient()
  void organizations.create({ name: 'Analytical Engines', slug: 'analytical-engines' })
  void organizations.setActive(1)
}

void tableTypeContract
