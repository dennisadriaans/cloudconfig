/** The users screen: a reusable server-driven table and the page that composes it. */
export const NUXT_USERS_TEMPLATE = {
  'app/components/ServerTable.vue': `<script setup lang="ts" generic="Row extends { id: number }, Key extends keyof Row & string">
import type { TableState } from '@cloudconfig/core/client'
import type { DropdownMenuItem, TableColumn } from '@nuxt/ui'

export interface Column<K> {
  key: K
  label: string
}

const {
  state,
  columns,
  label = 'records',
} = defineProps<{
  state: TableState<Row, Key>
  columns: readonly Column<Key>[]
  label?: string
}>()

const emit = defineEmits<{
  search: [value: string]
  sort: [key: Key]
  page: [value: number]
  retry: []
  edit: [row: Row]
  remove: [rows: Row[]]
}>()

const busy = computed(() => state.pending || state.saving)

const rowSelection = ref<Record<string, boolean>>({})
const columnVisibility = ref<Record<string, boolean>>({})

const selectedRows = computed(() =>
  state.result.data.filter((row) => rowSelection.value[String(row.id)]),
)

watch(
  () => state.result.data,
  () => (rowSelection.value = {}),
)

const tableColumns = computed<TableColumn<Row>[]>(() => [
  { id: 'select', enableHiding: false },
  ...columns.map((column) => ({
    id: column.key,
    accessorFn: (row: Row) => row[column.key],
  })),
  { id: 'actions', enableHiding: false },
])

const columnItems = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: 'Toggle columns' }],
  columns.map((column) => ({
    type: 'checkbox' as const,
    label: column.label,
    checked: columnVisibility.value[column.key] !== false,
    onUpdateChecked: (checked: boolean) => {
      columnVisibility.value = { ...columnVisibility.value, [column.key]: checked }
    },
    onSelect: (event: Event) => event.preventDefault(),
  })),
])

function sortIcon(key: Key): string {
  if (state.query.sortBy !== key) return 'i-hugeicons-unfold-more'
  return state.query.sortDir === 'desc'
    ? 'i-hugeicons-sort-by-down-01'
    : 'i-hugeicons-sort-by-up-01'
}

function removeSelected() {
  emit('remove', selectedRows.value)
}
</script>

<template>
  <section class="flex flex-col gap-4" :aria-label="label">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-2">
        <div v-if="selectedRows.length" class="flex items-center gap-2">
          <span class="text-sm text-muted">{{ selectedRows.length }} selected</span>
          <UButton
            color="error"
            variant="soft"
            :label="\`Delete selected\${selectedRows.length > 1 ? \` (\${selectedRows.length})\` : ''}\`"
            :loading="state.saving"
            :disabled="busy"
            @click="removeSelected"
          />
        </div>

        <UInput
          :model-value="state.query.search ?? ''"
          type="search"
          icon="i-hugeicons-search-01"
          class="w-56"
          :aria-label="\`Search \${label}\`"
          :placeholder="\`Search \${label}…\`"
          @update:model-value="emit('search', String($event))"
        />
        <slot name="filters" />
      </div>

      <div class="flex items-center gap-2">
        <slot name="actions" />
        <UDropdownMenu :items="columnItems" :content="{ align: 'end' }">
          <UButton variant="outline" icon="i-hugeicons-table-columns-split" label="Columns" />
        </UDropdownMenu>
      </div>
    </div>

    <UAlert
      v-if="state.error"
      color="neutral"
      variant="subtle"
      icon="i-hugeicons-alert-circle"
      :title="\`Could not load \${label}\`"
      :description="state.error.message"
      :actions="[
        { label: 'Try again', color: 'neutral', variant: 'outline', onClick: () => emit('retry') },
      ]"
    />

    <div
      v-else
      class="overflow-hidden rounded-xl border border-default bg-default dark:bg-transparent"
      :aria-busy="state.pending"
    >
      <UTable
        v-model:row-selection="rowSelection"
        v-model:column-visibility="columnVisibility"
        :data="state.result.data"
        :columns="tableColumns"
        :get-row-id="(row: Row) => String(row.id)"
        caption="Records matching the current search and filters"
        :empty="state.pending ? 'Loading…' : 'No results found.'"
      >
        <template #select-header="{ table }">
          <UCheckbox
            :model-value="
              table.getIsSomePageRowsSelected() ? 'indeterminate' : table.getIsAllPageRowsSelected()
            "
            aria-label="Select all"
            @update:model-value="table.toggleAllPageRowsSelected(!!$event)"
          />
        </template>
        <template #select-cell="{ row }">
          <UCheckbox
            :model-value="row.getIsSelected()"
            aria-label="Select row"
            @update:model-value="row.toggleSelected(!!$event)"
          />
        </template>

        <template v-for="column in columns" :key="column.key" #[\`\${column.key}-header\`]>
          <UButton variant="link" @click="emit('sort', column.key)">
            {{ column.label }}
            <UIcon
              :name="sortIcon(column.key)"
              class="size-3.5"
              :class="{ 'text-muted': state.query.sortBy !== column.key }"
            />
          </UButton>
        </template>
        <template v-for="column in columns" :key="column.key" #[\`\${column.key}-cell\`]="{ row }">
          <slot name="cell" :row="row.original" :column="column">
            <span class="font-medium">{{ row.original[column.key] ?? '—' }}</span>
          </slot>
        </template>

        <template #actions-cell="{ row }">
          <div class="flex items-center justify-end gap-2">
            <UButton
              variant="ghost"
              size="xs"
              icon="i-hugeicons-pencil-edit-02"
              :aria-label="\`Edit \${label}\`"
              :disabled="busy"
              @click="emit('edit', row.original)"
            />
          </div>
        </template>
      </UTable>

      <div
        v-if="state.result.totalPages > 1"
        class="flex items-center justify-between border-t border-default px-4 py-3 text-sm text-muted"
      >
        <span aria-live="polite">
          Page {{ state.result.page }} of {{ state.result.totalPages }} ({{
            state.result.totalCount
          }}
          total)
        </span>
        <div class="flex gap-2">
          <UButton
            variant="outline"
            icon="i-hugeicons-chevron-left"
            aria-label="Previous page"
            :disabled="state.result.page <= 1 || state.pending"
            @click="emit('page', state.result.page - 1)"
          />
          <UButton
            variant="outline"
            icon="i-hugeicons-chevron-right"
            aria-label="Next page"
            :disabled="state.result.page >= state.result.totalPages || state.pending"
            @click="emit('page', state.result.page + 1)"
          />
        </div>
      </div>
    </div>
  </section>
</template>
`,
  'app/components/UserFormDialog.vue': `<script setup lang="ts">
import type { AdminUser } from '@cloudconfig/core/client'

export interface UserFormValues {
  name: string
  email: string
}

const { user = null, saving = false } = defineProps<{
  /** The account being edited, or \`null\` to create a new one. */
  user?: AdminUser | null
  saving?: boolean
  error?: string
}>()

const emit = defineEmits<{ submit: [values: UserFormValues] }>()

const open = defineModel<boolean>('open', { required: true })

const name = ref('')
const email = ref('')
const editing = computed(() => user !== null)
const submittable = computed(() => name.value.trim() !== '' && email.value.trim() !== '')

watch(open, (isOpen) => {
  if (!isOpen) return
  name.value = user?.name ?? ''
  email.value = user?.email ?? ''
})

function submit() {
  emit('submit', { name: name.value.trim(), email: email.value.trim() })
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="editing ? 'Edit user' : 'Add user'"
    :dismissible="!saving"
    :close="{ disabled: saving }"
  >
    <template #body>
      <form id="user-form" class="space-y-5" @submit.prevent="submit">
        <UFormField label="Name" required>
          <UInput
            v-model="name"
            autofocus
            required
            maxlength="200"
            class="w-full"
            :disabled="saving"
          />
        </UFormField>
        <UFormField label="Email" required>
          <UInput
            v-model="email"
            type="email"
            required
            class="w-full"
            :disabled="editing || saving"
          />
        </UFormField>
        <p class="text-sm text-muted">
          {{
            editing
              ? 'Email changes require verification and are managed by the account owner.'
              : 'The user can sign in with GitHub using this email. No invitation is sent.'
          }}
        </p>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-hugeicons-alert-circle"
          title="Could not save this user"
          :description="error"
        />
      </form>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton label="Cancel" variant="outline" :disabled="saving" @click="open = false" />
        <UButton
          type="submit"
          form="user-form"
          label="Save user"
          :loading="saving"
          :disabled="!submittable"
        />
      </div>
    </template>
  </UModal>
</template>
`,
  'app/composables/useUserDirectory.ts': `import { createFilters, type AdminUser } from '@cloudconfig/core/client'

export type VerificationFilter = 'all' | 'verified' | 'unverified'

const filters = createFilters<AdminUser>()

/**
 * The administrable user list, backed by the auth admin routes.
 *
 * Wraps the generic table controller with the sorting and filtering this
 * screen offers, so the page itself stays presentational.
 */
export function useUserDirectory() {
  const table = useCloudConfigTable('users', useCloudConfigAdmin(), {
    pageSize: 20,
    sortBy: 'createdAt',
    sortDir: 'desc',
  })

  /** Admin routes answer 403 until the account is listed in \`auth.admin.userIds\`. */
  const accessDenied = computed(() => {
    const { error } = table.state.value
    return !!error && 'status' in error && error.status === 403
  })

  function toggleSort(key: keyof AdminUser) {
    const { sortBy, sortDir } = table.state.value.query
    return table.setSort(key, sortBy === key && sortDir === 'asc' ? 'desc' : 'asc')
  }

  function filterByVerification(verification: VerificationFilter) {
    return table.setFilters(
      verification === 'all'
        ? filters.and()
        : filters.and(filters.where('emailVerified', 'eq', verification === 'verified')),
    )
  }

  return { ...table, accessDenied, toggleSort, filterByVerification }
}
`,
  'app/pages/dashboard/index.vue': `<script setup lang="ts">
import type { AdminUser } from '@cloudconfig/core/client'
import type { Column } from '~/components/ServerTable.vue'
import type { UserFormValues } from '~/components/UserFormDialog.vue'

definePageMeta({ layout: 'dashboard', middleware: ['auth'], title: 'Users' })

const columns: readonly Column<keyof AdminUser & string>[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'emailVerified', label: 'Email status' },
  { key: 'createdAt', label: 'Joined' },
]

const VERIFICATION_OPTIONS: { label: string; value: VerificationFilter }[] = [
  { label: 'Any status', value: 'all' },
  { label: 'Verified', value: 'verified' },
  { label: 'Unverified', value: 'unverified' },
]

const directory = useUserDirectory()
const { state, accessDenied } = directory
const currentUser = useCurrentUser()

const editorOpen = ref(false)
const editing = ref<AdminUser | null>(null)
const verification = ref<VerificationFilter>('all')

watch(verification, (value) => directory.filterByVerification(value))

function openEditor(user: AdminUser | null) {
  editing.value = user
  editorOpen.value = true
}

/** Leaves the dialog open when a write fails, so the error stays next to the form. */
async function save({ name, email }: UserFormValues) {
  const target = editing.value
  await (target ? directory.update(target.id, { name }) : directory.create({ name, email })).catch(
    () => undefined,
  )
  editorOpen.value = Boolean(state.value.mutationError)
}

async function remove(users: AdminUser[]) {
  const subject = users.length === 1 ? users[0]!.name : \`\${users.length} users\`
  const confirmed = window.confirm(
    \`Delete \${subject}? Their sign-in accounts and sessions will also be deleted. This cannot be undone.\`,
  )
  if (!confirmed) return
  for (const user of users) {
    const deleted = await directory.delete(user.id).then(
      () => true,
      () => false,
    )
    if (!deleted) return
  }
}

await directory.ready
</script>

<template>
  <UDashboardPanel>
    <template #body>
      <div class="flex min-h-0 flex-1 gap-4">
        <UCard variant="subtle" class="min-w-0 flex-1">
          <div class="flex flex-col gap-4">
            <div class="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 class="text-2xl font-semibold tracking-tight">Users</h1>
                <p class="text-sm text-muted">Manage who can sign in to your application.</p>
              </div>
              <UButton
                v-if="!accessDenied"
                icon="i-hugeicons-plus-sign"
                label="Create"
                :disabled="state.saving || !!state.error"
                @click="openEditor(null)"
              />
            </div>

            <UAlert
              v-if="accessDenied"
              color="neutral"
              variant="subtle"
              icon="i-hugeicons-lock-keyhole"
              title="Access required"
              :description="\`Add your account ID to auth.admin.userIds in cloud.config.ts to manage users.\${
                currentUser ? \` Your account ID is \${currentUser.id}.\` : ''
              }\`"
              :actions="[
                {
                  label: 'Check access',
                  color: 'neutral',
                  variant: 'outline',
                  loading: state.pending,
                  onClick: () => directory.refresh(),
                },
              ]"
            />

            <template v-else>
              <UAlert
                v-if="state.mutationError && !editorOpen"
                color="error"
                variant="subtle"
                icon="i-hugeicons-alert-circle"
                title="Could not save your changes"
                :description="state.mutationError.message"
              />

              <!-- @vue-generic {AdminUser, keyof AdminUser & string} -->
              <ServerTable
                label="users"
                :state="state"
                :columns="columns"
                @search="directory.setSearch"
                @sort="directory.toggleSort"
                @page="directory.setPage"
                @retry="directory.refresh"
                @edit="openEditor"
                @remove="remove"
              >
                <template #filters>
                  <USelect
                    v-model="verification"
                    :items="VERIFICATION_OPTIONS"
                    aria-label="Email verification"
                    class="w-40"
                  />
                </template>

                <template #cell="{ row, column }">
                  <div v-if="column.key === 'name'" class="flex items-center gap-2">
                    <UAvatar :src="row.image ?? undefined" :alt="row.name" size="xs" />
                    <span class="font-medium">{{ row.name }}</span>
                  </div>
                  <UBadge
                    v-else-if="column.key === 'emailVerified'"
                    :variant="row.emailVerified ? 'solid' : 'soft'"
                    :label="row.emailVerified ? 'Verified' : 'Unverified'"
                  />
                  <span v-else-if="column.key === 'createdAt'" class="font-medium">
                    {{ row.createdAt.slice(0, 10) }}
                  </span>
                  <span v-else class="font-medium">{{ row[column.key] }}</span>
                </template>
              </ServerTable>
            </template>

            <UserFormDialog
              v-model:open="editorOpen"
              :user="editing"
              :saving="state.saving"
              :error="state.mutationError?.message"
              @submit="save"
            />
          </div>
        </UCard>
      </div>
    </template>
  </UDashboardPanel>
</template>
`,
} as const
