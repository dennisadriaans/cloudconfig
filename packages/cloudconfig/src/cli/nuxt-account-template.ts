/** Account settings and organization workspaces for the Nuxt dashboard. */
export const NUXT_ACCOUNT_TEMPLATE = {
  'app/components/settings/Organizations.vue': `<script setup lang="ts">
import type { Organization } from '@cloudconfig/core/client'

const organizations = useCloudConfigOrganizations()
const activeOrganization = useState<Organization | null>('active-organization', () => null)
const route = useRoute()
const items = ref<Organization[]>([])
const pending = ref(true)
const saving = ref(false)
const error = ref('')
const name = ref('')
const slug = ref('')
const creating = computed(() => route.query.create === 'true')
const nameInput = useTemplateRef('nameInput')
const fieldUi = {
  root: 'w-full',
  base: 'h-10 rounded-md bg-(--gray-100) px-3 py-0 text-sm font-normal text-highlighted ring-(--gray-500) focus-visible:ring-highlighted',
}
const formFieldUi = {
  label: 'text-[13px] font-normal text-muted',
  container: 'mt-1.5',
}

function updateName(value: string) {
  name.value = value
  slug.value = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function showEditor() {
  return navigateTo({
    path: '/dashboard/settings',
    query: { ...route.query, create: 'true' },
    hash: '#organizations',
  })
}

function closeEditor() {
  const query = { ...route.query }
  delete query.create
  name.value = ''
  slug.value = ''
  error.value = ''
  return navigateTo({ path: '/dashboard/settings', query, hash: '#organizations' })
}

async function refresh() {
  pending.value = true
  error.value = ''
  try {
    items.value = await organizations.list()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load organizations.'
  } finally {
    pending.value = false
  }
}

async function createOrganization() {
  if (saving.value || !name.value.trim() || !slug.value.trim()) return
  saving.value = true
  error.value = ''
  try {
    const created = await organizations.create({ name: name.value.trim(), slug: slug.value.trim() })
    activeOrganization.value = created
    items.value = [created, ...items.value.filter((item) => item.id !== created.id)]
    await refreshNuxtData('workspace-organization')
    await closeEditor()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not create the organization.'
  } finally {
    saving.value = false
  }
}

async function activate(item: Organization) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    activeOrganization.value = await organizations.setActive(item.id)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not select the organization.'
  } finally {
    saving.value = false
  }
}

watch(
  creating,
  async (value) => {
    if (!value) return
    await nextTick()
    nameInput.value?.inputRef?.focus()
  },
  { flush: 'post' },
)

onMounted(() => {
  void refresh()
  if (creating.value) nameInput.value?.inputRef?.focus()
})
</script>

<template>
  <SettingsSection
    id="organizations"
    title="Organization"
    description="Manage your shared workspaces."
    class="scroll-mt-6"
  >
    <p v-if="error" role="alert" class="text-[13px] text-error">{{ error }}</p>
    <div :aria-busy="pending" class="grid gap-4">
      <div v-for="item in items" :key="item.id" class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="truncate text-sm text-highlighted">{{ item.name }}</p>
          <p class="mt-0.5 truncate text-[13px] text-muted">{{ item.slug }}</p>
        </div>
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          :label="activeOrganization?.id === item.id ? 'Active' : 'Use organization'"
          :disabled="saving || activeOrganization?.id === item.id"
          class="h-9 shrink-0 rounded-md px-3 text-sm font-normal"
          @click="activate(item)"
        />
      </div>
      <p v-if="pending" role="status" class="text-[13px] text-muted">Loading organizations…</p>
      <p v-else-if="!items.length && !error" class="text-sm text-muted">
        No organizations yet. Create one to start a shared workspace.
      </p>
    </div>
    <form
      v-if="creating"
      class="grid gap-4"
      @submit.prevent="createOrganization"
      @keydown.esc.stop.prevent="!saving && closeEditor()"
    >
      <UFormField label="Name" :ui="formFieldUi">
        <UInput
          ref="nameInput"
          :model-value="name"
          required
          :disabled="saving"
          :ui="fieldUi"
          @update:model-value="updateName"
        />
      </UFormField>
      <UFormField label="Slug" :ui="formFieldUi">
        <UInput v-model="slug" required pattern="[a-z0-9-]+" :disabled="saving" :ui="fieldUi" />
      </UFormField>
      <div class="flex flex-wrap gap-2">
        <UButton
          type="submit"
          label="Create organization"
          :loading="saving"
          :disabled="!name.trim() || !slug.trim()"
          class="h-10 rounded-md px-4 text-sm font-medium"
        />
        <UButton
          type="button"
          color="neutral"
          variant="outline"
          label="Cancel"
          :disabled="saving"
          class="h-10 rounded-md px-4 text-sm font-normal"
          @click="closeEditor"
        />
      </div>
    </form>
    <UButton
      v-else
      type="button"
      color="neutral"
      variant="outline"
      icon="i-lucide-plus"
      label="New organization"
      :disabled="saving"
      class="h-10 w-fit rounded-md px-4 text-sm font-normal"
      @click="showEditor"
    />
  </SettingsSection>
</template>
`,
  'app/components/settings/Security.vue': `<script setup lang="ts">
import type { AuthAccount } from '@cloudconfig/core/client'

const account = useCloudConfigAccount()
const user = useCurrentUser()
const currentPassword = ref('')
const newPassword = ref('')
const deletePassword = ref('')
const busy = ref(false)
const loaded = ref(false)
const message = ref('')
const error = ref('')
const accounts = ref<AuthAccount[]>([])
const hasPassword = computed(() => accounts.value.some((item) => item.providerId === 'credential'))
const fieldUi = {
  root: 'w-full',
  base: 'h-10 rounded-md bg-(--gray-100) px-3 py-0 text-sm font-normal text-highlighted ring-(--gray-500) focus-visible:ring-highlighted',
}
const formFieldUi = {
  label: 'text-[13px] font-normal text-muted',
  container: 'mt-1.5',
}

onMounted(async () => {
  try {
    accounts.value = await account.listAccounts()
    loaded.value = true
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'Could not load security settings. Refresh to try again.'
  }
})

async function changePassword() {
  if (busy.value || !currentPassword.value || newPassword.value.length < 8) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await account.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
      revokeOtherSessions: true,
    })
    currentPassword.value = ''
    newPassword.value = ''
    message.value = 'Password changed and other sessions revoked.'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not change your password.'
  } finally {
    busy.value = false
  }
}

async function removeAccount() {
  if (
    busy.value ||
    !loaded.value ||
    !window.confirm(
      'Permanently delete your account, sessions, and linked sign-in methods? This cannot be undone.',
    )
  )
    return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await account.deleteUser(deletePassword.value ? { password: deletePassword.value } : {})
    user.value = null
    await navigateTo('/sign-in')
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'Could not delete your account. Sign in again and retry.'
    busy.value = false
  }
}
</script>

<template>
  <div id="security" class="scroll-mt-6">
    <SettingsTwoFactor :has-password="hasPassword" />
    <SettingsSection title="Security" description="Manage how you sign in.">
      <p v-if="error" role="alert" class="text-[13px] text-error">{{ error }}</p>
      <p v-if="message" role="status" class="text-[13px] text-muted">{{ message }}</p>
      <form v-if="hasPassword" class="grid gap-4" @submit.prevent="changePassword">
        <UFormField label="Current password" :ui="formFieldUi">
          <UInput
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            :disabled="busy"
            :ui="fieldUi"
          />
        </UFormField>
        <UFormField label="New password" :ui="formFieldUi">
          <UInput
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            required
            minlength="8"
            :disabled="busy"
            :ui="fieldUi"
          />
        </UFormField>
        <p class="text-[13px] text-muted">Changing your password signs out your other sessions.</p>
        <UButton
          type="submit"
          label="Change password"
          :loading="busy"
          :disabled="!currentPassword || newPassword.length < 8"
          class="h-10 w-fit rounded-md px-4 text-sm font-medium"
        />
      </form>
      <p v-else-if="loaded" class="text-sm text-muted">
        Your sign-in provider manages your password.
      </p>
      <p v-else-if="!error" role="status" class="text-[13px] text-muted">
        Loading security settings…
      </p>
    </SettingsSection>
    <SettingsSection
      title="Delete account"
      description="Permanently remove your profile, sessions, and linked sign-in accounts."
    >
      <UFormField v-if="hasPassword" label="Password" :ui="formFieldUi">
        <UInput
          v-model="deletePassword"
          type="password"
          autocomplete="current-password"
          :disabled="busy"
          :ui="fieldUi"
        />
      </UFormField>
      <p v-else-if="loaded" class="text-[13px] text-muted">
        Sign in again before deleting your account.
      </p>
      <UButton
        type="button"
        color="error"
        variant="outline"
        label="Delete my account"
        :loading="busy"
        :disabled="!loaded"
        class="h-10 w-fit rounded-md px-4 text-sm font-normal"
        @click="removeAccount"
      />
    </SettingsSection>
  </div>
</template>
`,
  'app/components/settings/TwoFactor.vue': `<script setup lang="ts">
import type { TwoFactorStatus } from '@cloudconfig/core/client'

defineProps<{ hasPassword?: boolean }>()
const auth = useCloudConfigTwoFactor()
const account = useCloudConfigAccount()
const user = useCurrentUser()
const config = useRuntimeConfig().public.cloudconfig as { twoFactor?: { passkey: boolean } }
const passkeyEnabled = config.twoFactor?.passkey !== false
const status = ref<TwoFactorStatus | null>(null)
const keys = ref<{ id: string; name?: string | undefined }[]>([])
const busy = ref(false)
const enrollingEmail = ref(false)
const code = ref('')
const password = ref('')
const error = ref('')
const message = ref('')

async function load() {
  status.value = await account.getTwoFactorStatus()
  if (passkeyEnabled) {
    const result = await auth.passkey.listUserPasskeys()
    if (result.error) throw new Error(result.error.message ?? 'Could not load passkeys.')
    keys.value = result.data ?? []
  }
}

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await action()
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Could not update two-factor authentication.'
  } finally {
    busy.value = false
  }
}

onMounted(() => run(load))

function sendCode() {
  return run(async () => {
    const result = await auth.twoFactor.sendOtp({})
    if (result.error)
      throw new Error(result.error.message ?? 'Could not send the verification code.')
    enrollingEmail.value = true
    code.value = ''
    message.value = \`We sent a verification code to \${user.value?.email}.\`
  })
}

function verifyCode() {
  return run(async () => {
    const result = await auth.twoFactor.verifyOtp({ code: code.value })
    if (result.error) throw new Error(result.error.message ?? 'The code is invalid or expired.')
    enrollingEmail.value = false
    code.value = ''
    await load()
    message.value = 'Email two-factor authentication is enabled.'
  })
}

function usePasskey(add = false) {
  return run(async () => {
    const result =
      add || !keys.value.length ? await auth.passkey.addPasskey({}) : await auth.signIn.passkey()
    if (result.error) throw new Error(result.error.message ?? 'Could not verify your passkey.')
    enrollingEmail.value = false
    await load()
    message.value = 'Passkey two-factor authentication is enabled.'
  })
}

function removePasskey(id: string) {
  return run(async () => {
    const result = await auth.passkey.deletePasskey({ id })
    if (result.error) throw new Error(result.error.message ?? 'Could not remove the passkey.')
    await load()
  })
}

function disable() {
  return run(async () => {
    const result = await auth.twoFactor.disable({ password: password.value })
    if (result.error)
      throw new Error(result.error.message ?? 'Could not turn off two-factor authentication.')
    enrollingEmail.value = false
    password.value = ''
    await load()
    message.value = 'Two-factor authentication is turned off.'
  })
}
</script>

<template>
  <SettingsSection
    title="Two-factor authentication"
    description="Choose an email code or a passkey to verify after signing in."
  >
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="message" role="status" class="text-sm text-muted">{{ message }}</p>
    <p v-if="!status && !error" role="status" class="text-sm text-muted">
      Loading two-factor settings…
    </p>
    <template v-if="status">
      <p class="text-sm text-muted">
        {{
          status.enabled
            ? \`Enabled · \${status.method === 'passkey' ? 'Passkey' : 'Email code'}\`
            : 'Two-factor authentication is off.'
        }}
      </p>
      <div class="flex flex-wrap gap-2">
        <UButton
          label="Use email code"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="sendCode"
        />
        <UButton
          v-if="passkeyEnabled"
          label="Use passkey"
          color="neutral"
          variant="outline"
          :disabled="busy"
          @click="usePasskey()"
        />
      </div>
      <form
        v-if="enrollingEmail"
        class="flex flex-wrap items-end gap-2"
        @submit.prevent="verifyCode"
      >
        <UFormField label="Verification code">
          <UInput
            v-model="code"
            autocomplete="one-time-code"
            inputmode="numeric"
            pattern="[0-9]{6}"
            maxlength="6"
            required
            :disabled="busy"
            autofocus
          />
        </UFormField>
        <UButton
          type="submit"
          label="Verify and enable"
          :loading="busy"
          :disabled="code.length !== 6"
        />
        <UButton
          label="Resend code"
          color="neutral"
          variant="link"
          :disabled="busy"
          @click="sendCode"
        />
        <UButton
          label="Cancel"
          color="neutral"
          variant="link"
          :disabled="busy"
          @click="enrollingEmail = false"
        />
      </form>
      <div v-if="keys.length" class="space-y-2">
        <div
          v-for="key in keys"
          :key="key.id"
          class="flex items-center justify-between gap-3 text-sm"
        >
          <span class="text-muted">{{ key.name || 'Passkey' }}</span>
          <UButton
            label="Remove"
            color="neutral"
            variant="link"
            :disabled="busy"
            @click="removePasskey(key.id)"
          />
        </div>
        <UButton
          label="Add passkey"
          color="neutral"
          variant="link"
          :disabled="busy"
          @click="usePasskey(true)"
        />
      </div>
      <div v-if="status.enabled" class="flex flex-wrap items-end gap-2">
        <UFormField v-if="hasPassword" label="Current password">
          <UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            :disabled="busy"
          />
        </UFormField>
        <UButton
          label="Turn off 2FA"
          color="neutral"
          variant="link"
          :disabled="busy || (hasPassword && !password)"
          @click="disable"
        />
      </div>
    </template>
  </SettingsSection>
</template>
`,
  'app/pages/dashboard/settings.vue': `<script setup lang="ts">
definePageMeta({ layout: 'dashboard', middleware: ['auth'], title: 'Settings' })

function onEscape(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) return
  if (
    document.querySelector(
      '[data-state="open"]:is([role="dialog"], [role="menu"], [role="listbox"]), dialog[open]',
    )
  )
    return
  event.preventDefault()
  void navigateTo('/dashboard')
}

onMounted(() => document.addEventListener('keydown', onEscape))
onBeforeUnmount(() => document.removeEventListener('keydown', onEscape))
</script>

<template>
  <UDashboardPanel :ui="{ body: 'block p-0 sm:p-0' }">
    <template #body>
      <div
        class="mx-auto w-full max-w-190 origin-bottom-left px-6 pt-10 pb-24 opacity-100 scale-100 [clip-path:inset(0_0_0_0)] transition-[clip-path,scale,opacity] duration-[260ms,260ms,200ms] ease-out starting:opacity-0 starting:scale-[0.97] starting:[clip-path:inset(100%_100%_0_0)] motion-reduce:transition-none"
      >
        <h1 class="mb-8 text-[32px] leading-[1.1] font-normal tracking-[-0.03em] text-highlighted">
          Settings
        </h1>
        <NuxtPage />
      </div>
    </template>
  </UDashboardPanel>
</template>
`,
  'app/pages/dashboard/settings/index.vue': `<script setup lang="ts">
definePageMeta({ title: 'Settings' })

const account = useCloudConfigAccount()
const user = useCurrentUser()
const preferences = useDashboardPreferences()
const name = ref(user.value?.name ?? '')
const saving = ref(false)
const error = ref('')
const models = ['Fast', 'Balanced', 'Deep'] as const
const notifications = [
  {
    key: 'emailNotifications',
    label: 'Email notifications',
    description: 'Get an email when a request finishes.',
  },
  {
    key: 'weeklyDigest',
    label: 'Weekly digest',
    description: 'A summary every Monday.',
  },
] as const

const fieldUi = {
  root: 'w-full',
  base: 'h-10 rounded-md bg-(--gray-100) px-3 py-0 text-sm font-normal text-highlighted ring-default focus-visible:ring-highlighted',
}
const formFieldUi = {
  label: 'text-[13px] font-normal text-muted',
  container: 'mt-1.5',
}
const switchUi = {
  root: 'items-center justify-between gap-4',
  container: 'order-last h-5 shrink-0',
  wrapper: 'order-first ms-0 min-w-0 text-left',
  label: 'cursor-pointer text-sm leading-normal font-normal text-highlighted',
  description: 'mt-0.5 text-[13px] leading-normal text-muted',
  base: 'h-5 w-9 cursor-pointer data-[state=unchecked]:bg-(--gray-500) motion-reduce:transition-none',
  thumb: 'size-4 shadow-none data-[state=checked]:translate-x-4 motion-reduce:transition-none',
}

async function saveProfile() {
  if (saving.value) return false
  const value = name.value.trim()
  if (!value) {
    error.value = 'Enter your name.'
    return false
  }
  if (value === user.value?.name) return true

  saving.value = true
  error.value = ''
  try {
    await account.updateUser({ name: value })
    if (user.value) user.value = { ...user.value, name: value }
    name.value = value
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not update your profile.'
    return false
  } finally {
    saving.value = false
  }
}

async function finish() {
  if (await saveProfile()) await navigateTo('/dashboard')
}
</script>

<template>
  <div>
    <form id="settings-profile" @submit.prevent="finish">
      <SettingsSection title="Profile" description="Shown in the sidebar.">
        <UFormField label="Name" :ui="formFieldUi">
          <UInput
            v-model="name"
            required
            maxlength="200"
            autocomplete="name"
            :disabled="saving"
            :ui="fieldUi"
          />
        </UFormField>
        <UFormField label="Email" :ui="formFieldUi">
          <UInput
            :model-value="user?.email ?? ''"
            type="email"
            autocomplete="email"
            readonly
            title="Email is managed by your sign-in provider"
            :ui="fieldUi"
          />
        </UFormField>
        <p v-if="error" role="alert" class="text-[13px] text-error">{{ error }}</p>
      </SettingsSection>

      <SettingsSection title="Default model" description="Used for new requests.">
        <div class="flex flex-wrap gap-2" role="group" aria-label="Default model">
          <UButton
            v-for="model in models"
            :key="model"
            type="button"
            variant="outline"
            :label="model"
            :aria-pressed="preferences.defaultModel === model"
            class="h-9 rounded-full border px-4 text-sm font-normal text-highlighted ring-0 transition-[background-color,border-color] duration-160 ease-out hover:bg-(--gray-500) motion-reduce:transition-none motion-reduce:active:scale-100"
            :class="
              preferences.defaultModel === model
                ? 'border-highlighted bg-(--gray-400)'
                : 'border-default bg-transparent'
            "
            @click="preferences.defaultModel = model"
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Notifications" description="Choose what reaches you.">
        <USwitch
          v-for="notification in notifications"
          :key="notification.key"
          v-model="preferences[notification.key]"
          color="neutral"
          size="md"
          :label="notification.label"
          :description="notification.description"
          :ui="switchUi"
        />
      </SettingsSection>

      <SettingsSection title="Email" description="Behavior in the triage view.">
        <USwitch
          v-model="preferences.autoAdvance"
          color="neutral"
          size="md"
          label="Auto-advance"
          description="Open the next email after you finish one."
          :ui="switchUi"
        />
      </SettingsSection>
    </form>

    <SettingsOrganizations />
    <SettingsSecurity />

    <div class="flex justify-end border-t border-default pt-6">
      <UButton
        type="submit"
        form="settings-profile"
        label="Done"
        class="h-10 min-w-18 justify-center rounded-md px-4 text-sm font-medium"
        :loading="saving"
        :disabled="!name.trim()"
      />
    </div>
  </div>
</template>
`,
  'app/pages/dashboard/organizations.vue': `<script setup lang="ts">
definePageMeta({ redirect: '/dashboard/settings#organizations' })
</script>
`,
} as const
