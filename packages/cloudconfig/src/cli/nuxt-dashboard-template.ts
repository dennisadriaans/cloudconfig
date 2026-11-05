import { NUXT_USERS_TEMPLATE } from './nuxt-users-template.js'
import { NUXT_ACCOUNT_TEMPLATE } from './nuxt-account-template.js'

/** A greenfield Nuxt UI dashboard that mirrors the agentic-content shadcn shell. */
export const NUXT_DASHBOARD_TEMPLATE = {
  'app/app.vue': `<script setup lang="ts">
import '~/assets/css/main.css'

useHead({ htmlAttrs: { lang: 'en' } })
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
`,
  'app/app.config.ts': `const fieldCompoundVariants = [
  {
    color: 'neutral' as const,
    variant: ['outline' as const, 'subtle' as const],
    class: 'focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accented',
  },
]

const field = {
  slots: {
    base: 'rounded-md shadow-none text-sm transition-[box-shadow] duration-150 ease-out',
    leadingIcon: 'text-muted',
    trailingIcon: 'text-muted',
  },
  variants: {
    variant: {
      outline: 'bg-transparent ring-default text-highlighted',
      subtle: 'bg-elevated ring-default text-highlighted',
    },
    size: {
      md: { base: 'h-8', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
      lg: { base: 'h-10 px-3', leadingIcon: 'size-4', trailingIcon: 'size-4' },
    },
  },
  defaultVariants: { color: 'neutral', variant: 'outline', size: 'md' },
} as const

export default defineAppConfig({
  icon: {
    // Geist draws Lucide at a 1.5px stroke.
    customize: (content: string) => content.replaceAll('stroke-width="2"', 'stroke-width="1.5"'),
  },
  ui: {
    colors: {
      primary: 'neutral',
      success: 'green',
      neutral: 'neutral',
    },
    avatar: {
      slots: {
        root: 'bg-accented',
        fallback: 'font-semibold text-highlighted',
      },
      variants: {
        size: {
          '2xs': { root: 'size-[22px]', fallback: 'text-[10px]' },
          xs: { root: 'size-6', fallback: 'text-[11px]' },
          sm: { root: 'size-7', fallback: 'text-xs' },
          md: { root: 'size-8', fallback: 'text-xs' },
          xl: { root: 'size-12', fallback: 'text-base' },
        },
      },
    },
    button: {
      slots: {
        base: 'cursor-pointer rounded-md font-medium shadow-none transition-[background-color,color,transform] duration-120 ease-out active:scale-[0.98] disabled:active:scale-100',
      },
      defaultVariants: { color: 'neutral', size: 'sm' },
      variants: {
        size: {
          xs: { base: 'h-6 px-2 text-xs gap-1', leadingIcon: 'size-3.5', trailingIcon: 'size-3.5' },
          sm: {
            base: 'h-7 px-2.5 text-[13px] gap-1.5',
            leadingIcon: 'size-3.5',
            trailingIcon: 'size-3.5',
          },
          md: { base: 'h-9 px-3.5 text-sm gap-1.5', leadingIcon: 'size-4', trailingIcon: 'size-4' },
          lg: { base: 'h-10 px-4 text-sm gap-2' },
        },
      },
      compoundVariants: [
        // Geist "primary": white on black, softening to gray-1000 on hover.
        {
          color: ['primary', 'neutral'],
          variant: 'solid',
          class: 'bg-inverted text-inverted hover:bg-(--gray-1000) disabled:bg-inverted',
        },
        // Geist "secondary": transparent with a strong hairline.
        {
          color: 'neutral',
          variant: 'outline',
          class: 'bg-transparent text-highlighted ring-accented hover:bg-elevated',
        },
        // Geist "ghost": muted text that lights up on hover.
        {
          color: 'neutral',
          variant: 'ghost',
          class: 'text-muted hover:bg-elevated hover:text-highlighted',
        },
        {
          color: 'neutral',
          variant: 'link',
          class: 'h-auto p-0 text-highlighted hover:text-muted',
        },
        { size: 'xs', square: true, class: 'size-6 justify-center p-0' },
        { size: 'sm', square: true, class: 'size-7 justify-center p-0' },
        { size: 'md', square: true, class: 'size-8 justify-center p-0' },
      ],
    },
    card: {
      slots: {
        root: 'rounded-[10px] bg-muted shadow-none ring ring-default divide-y-0',
        header: 'px-5 pt-5',
        title: 'text-base font-semibold tracking-tight text-highlighted',
        description: 'mt-1 text-[13px] text-muted',
        body: 'p-5 sm:p-5',
        footer: 'px-5 pt-0 pb-5',
      },
      variants: {
        variant: {
          subtle: {
            root: 'flex max-h-full min-h-0 self-start flex-col divide-y divide-default',
            body: 'min-h-0 flex-1 overflow-y-auto p-5 sm:p-5',
            footer: 'bg-elevated p-5 sm:px-5',
          },
        },
      },
    },
    input: {
      slots: { ...field.slots, base: \`\${field.slots.base} placeholder:text-dimmed\` },
      variants: field.variants,
      compoundVariants: fieldCompoundVariants,
      defaultVariants: field.defaultVariants,
    },
    textarea: {
      slots: { ...field.slots, base: \`\${field.slots.base} placeholder:text-dimmed\` },
      variants: { variant: field.variants.variant },
      compoundVariants: fieldCompoundVariants,
      defaultVariants: field.defaultVariants,
    },
    select: {
      slots: {
        ...field.slots,
        placeholder: 'text-dimmed',
        content: 'rounded-[10px] bg-elevated shadow-none ring ring-default',
        item: 'rounded-md data-highlighted:not-data-disabled:before:bg-accented',
      },
      variants: field.variants,
      compoundVariants: fieldCompoundVariants,
      defaultVariants: field.defaultVariants,
    },
    selectMenu: {
      slots: {
        ...field.slots,
        placeholder: 'text-dimmed',
        content: 'rounded-[10px] bg-elevated shadow-none ring ring-default',
      },
      variants: field.variants,
      compoundVariants: fieldCompoundVariants,
      defaultVariants: field.defaultVariants,
    },
    formField: {
      slots: {
        label: 'text-[13px] font-normal text-muted',
        container: 'mt-2',
        hint: 'text-[13px] text-dimmed',
        help: 'text-[13px] text-muted',
      },
    },
    checkbox: {
      slots: {
        base: 'rounded-[4px] ring-accented transition-colors duration-150',
        icon: 'size-3',
      },
      defaultVariants: { color: 'neutral' },
    },
    switch: {
      slots: {
        base: 'data-[state=unchecked]:bg-accented',
        thumb:
          'shadow-none data-[state=unchecked]:bg-(--gray-900) data-[state=checked]:bg-(--ui-bg)',
      },
      defaultVariants: { color: 'neutral' },
    },
    badge: {
      slots: { base: 'rounded-full font-medium' },
      variants: {
        size: {
          md: { base: 'h-[22px] px-2 text-xs gap-1.5' },
        },
      },
      compoundVariants: [
        {
          color: 'neutral',
          variant: 'outline',
          class: 'bg-(--gray-200) text-default ring-(--ui-bg-accented)',
        },
      ],
      defaultVariants: { color: 'neutral', variant: 'outline' },
    },
    kbd: {
      base: 'font-mono font-normal text-muted',
      compoundVariants: [
        { color: 'neutral', variant: 'outline', class: 'bg-transparent ring-default' },
      ],
      defaultVariants: { color: 'neutral', variant: 'outline' },
    },
    alert: {
      slots: {
        root: 'gap-2 rounded-[10px] px-3 py-2.5',
        title: 'text-sm font-medium',
        description: 'text-[13px] text-muted opacity-100',
        icon: 'mt-0.5 size-4',
      },
      variants: {
        title: { true: { description: 'mt-0.5' } },
      },
      compoundVariants: [
        { color: 'neutral', variant: 'subtle', class: { root: 'bg-muted ring-default' } },
        { color: 'neutral', variant: 'outline', class: { root: 'bg-transparent ring-default' } },
      ],
    },
    separator: {
      slots: { border: 'border-default' },
      variants: {
        orientation: { vertical: { root: 'h-4 self-center' } },
      },
    },
    table: {
      slots: {
        root: 'relative overflow-auto',
        base: 'min-w-full border-collapse',
        tbody:
          'divide-y-0 [&>tr]:transition-colors [&>tr]:duration-150 [&>tr]:hover:bg-(--app-row-hover) [&>tr]:data-[selectable=true]:cursor-pointer',
        tr: 'data-[selected=true]:bg-(--app-row-hover)',
        th: 'h-9 bg-elevated px-3 py-0 text-start text-[13px] font-normal whitespace-nowrap text-muted border-b border-e border-default last:border-e-0 [&:has([role=checkbox])]:w-11 [&:has([role=checkbox])]:px-0',
        td: 'h-10 px-3 py-0 text-sm whitespace-nowrap text-default border-b border-e border-default last:border-e-0 [&:has([role=checkbox])]:px-0',
        separator: 'hidden',
        empty: 'h-30 text-center text-sm text-muted',
      },
    },
    tabs: {
      slots: {
        root: 'gap-6',
        list: 'rounded-lg p-[3px]',
      },
      variants: {
        size: {
          md: { trigger: 'px-2 py-[3px] text-sm' },
        },
      },
      compoundVariants: [
        {
          color: 'neutral',
          variant: 'pill',
          class: {
            indicator: 'bg-accented ring ring-accented',
            trigger: 'data-[state=active]:text-highlighted',
          },
        },
      ],
    },
    dropdownMenu: {
      slots: {
        content:
          'min-w-48 rounded-[10px] bg-elevated shadow-none ring ring-default data-[state=open]:animate-[menu-in_200ms_var(--ease-out)] data-[state=closed]:animate-[menu-out_120ms_var(--ease-out)]',
        item: 'rounded-md before:rounded-md',
        separator: 'bg-(--ui-border)',
        label: 'font-normal text-muted',
      },
      compoundVariants: [
        {
          color: 'neutral',
          active: false,
          class: {
            item: 'text-default data-highlighted:text-highlighted data-highlighted:before:bg-accented',
            itemLeadingIcon: 'text-muted group-data-highlighted:text-highlighted',
          },
        },
      ],
    },
    dashboardGroup: {
      base: 'fixed inset-0 flex overflow-hidden bg-default',
    },
    dashboardNavbar: {
      slots: {
        root: 'h-(--ui-header-height) border-b border-default bg-default sm:px-4',
        left: 'gap-2',
        title: 'text-sm font-medium text-highlighted',
        right: 'gap-2',
      },
    },
    dashboardSidebar: {
      slots: {
        root: 'min-h-0 bg-default',
        header: 'h-(--ui-header-height) px-2',
        body: 'gap-0 p-0',
        footer: 'p-2 border-t border-default',
      },
      variants: {
        side: { left: { root: 'border-e border-default' } },
      },
    },
    dashboardSidebarCollapse: {
      base: 'size-7 justify-center p-0',
    },
    dashboardSearchButton: {
      slots: {
        base: 'w-55 justify-start gap-2 bg-muted font-normal text-muted ring-default hover:bg-muted hover:ring-accented',
        trailing: 'ms-auto hidden lg:flex',
      },
    },
    dashboardPanel: {
      slots: {
        root: 'min-h-0 flex-1 bg-default',
        body: 'gap-4 p-4 sm:gap-4 sm:p-6',
      },
    },
    navigationMenu: {
      slots: {
        root: 'gap-0',
        label: 'h-8 px-2 py-0 text-xs font-normal text-dimmed',
        link: 'h-8 gap-2 rounded-md px-2 text-sm font-normal before:inset-0 before:rounded-md',
        linkLeadingIcon: 'size-4',
        linkTrailingBadge:
          'min-w-5 justify-center bg-transparent px-1 py-0.5 text-xs font-medium tabular-nums ring-0',
        separator: 'h-4 bg-transparent px-0',
      },
      variants: {
        active: {
          true: {
            link: 'text-highlighted before:bg-elevated',
            linkLeadingIcon: 'text-highlighted',
          },
          false: {
            link: 'text-muted hover:text-highlighted hover:before:bg-elevated',
            linkLeadingIcon: 'text-muted group-hover:text-highlighted',
          },
        },
      },
      compoundVariants: [
        {
          orientation: 'vertical',
          collapsed: true,
          class: { link: 'justify-center' },
        },
        // Top-bar tabs: underline the active tab, no filled pill.
        {
          orientation: 'horizontal',
          class: { item: 'py-0', link: 'h-10 px-3 before:hidden' },
        },
        {
          orientation: 'horizontal',
          highlight: true,
          class: { link: 'after:bottom-0 after:inset-x-3 after:h-0.5 after:rounded-none' },
        },
      ],
      defaultVariants: { color: 'neutral' },
    },
  },
})
`,
  'app/assets/css/main.css': `@import 'tailwindcss';
@import '@nuxt/ui';

@theme static {
  --font-sans: 'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace;
  --ease-out: cubic-bezier(0.2, 0, 0, 1);
}

/*
 * Geist tokens mapped onto Nuxt UI's semantic variables.
 * Monochrome: surfaces and 1px hairlines carry structure, no shadows.
 * Status hues only appear as small dots and verdicts.
 *
 *   Geist               Nuxt UI
 *   bg                  --ui-bg
 *   surface-card        --ui-bg-muted
 *   surface-raised      --ui-bg-elevated
 *   gray-500            --ui-bg-accented   (hover inside raised menus)
 *   border-subtle       --ui-border
 *   border-strong       --ui-border-accented
 *   text-body           --ui-text
 *   fg-2                --ui-text-muted
 */
:root {
  --ui-radius: 0.25rem;
  --ui-header-height: 3.5rem;

  --gray-100: #fafafa;
  --gray-200: #f5f5f5;
  --gray-300: #f0f0f0;
  --gray-400: #ebebeb;
  --gray-500: #e0e0e0;
  --gray-600: #c9c9c9;
  --gray-700: #a8a8a8;
  --gray-800: #8f8f8f;
  --gray-900: #666666;
  --gray-1000: #171717;

  --ui-primary: #000;
  --ui-success: oklch(0.6 0.16 150);
  --ui-warning: oklch(0.7 0.15 70);
  --ui-error: oklch(0.58 0.21 25);
  --ui-info: oklch(0.56 0.15 245);

  --ui-bg: #fff;
  --ui-bg-muted: #fff;
  --ui-bg-elevated: var(--gray-100);
  --ui-bg-accented: var(--gray-300);
  --ui-bg-inverted: #000;
  --ui-border: var(--gray-400);
  --ui-border-muted: var(--gray-300);
  --ui-border-accented: var(--gray-600);
  --ui-border-inverted: #000;
  --ui-text: var(--gray-1000);
  --ui-text-highlighted: #000;
  --ui-text-toned: var(--gray-1000);
  --ui-text-muted: var(--gray-900);
  --ui-text-dimmed: var(--gray-800);
  --ui-text-inverted: #fff;

  --app-row-hover: var(--gray-100);
  --app-row-current: var(--gray-200);
}

.dark {
  --gray-100: #0a0a0a;
  --gray-200: #0f0f0f;
  --gray-300: #161616;
  --gray-400: #1f1f1f;
  --gray-500: #2e2e2e;
  --gray-600: #3d3d3d;
  --gray-700: #5a5a5a;
  --gray-800: #7c7c7c;
  --gray-900: #a1a1a1;
  --gray-1000: #ededed;

  --ui-primary: #fff;
  --ui-success: oklch(0.78 0.14 150);
  --ui-warning: oklch(0.82 0.13 80);
  --ui-error: oklch(0.68 0.19 25);
  --ui-info: oklch(0.72 0.12 245);

  --ui-bg: #000;
  --ui-bg-muted: var(--gray-100);
  --ui-bg-elevated: var(--gray-300);
  --ui-bg-accented: var(--gray-500);
  --ui-bg-inverted: #fff;
  --ui-border: var(--gray-400);
  --ui-border-muted: var(--gray-300);
  --ui-border-accented: var(--gray-600);
  --ui-border-inverted: #fff;
  --ui-text: var(--gray-1000);
  --ui-text-highlighted: #fff;
  --ui-text-toned: var(--gray-1000);
  --ui-text-muted: var(--gray-900);
  --ui-text-dimmed: var(--gray-800);
  --ui-text-inverted: #000;

  --app-row-hover: var(--gray-200);
  --app-row-current: var(--gray-300);
}

html,
body,
#__nuxt {
  min-height: 100%;
}
body {
  min-width: 320px;
  margin: 0;
  background: var(--ui-bg);
  color: var(--ui-text);
  -webkit-font-smoothing: antialiased;
}
* {
  border-color: var(--ui-border);
}
::selection {
  background: var(--ui-text-highlighted);
  color: var(--ui-text-inverted);
}
input::placeholder {
  color: var(--ui-text-dimmed);
}

/* Popover reveal from the trigger's corner, as in the design's menus. */
@keyframes menu-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.97);
    clip-path: inset(0 0 100% 0 round 20px);
  }
  to {
    opacity: 1;
    transform: none;
    clip-path: inset(0 0 0 0 round 20px);
  }
}
@keyframes menu-out {
  from {
    opacity: 1;
    transform: none;
  }
  to {
    opacity: 0;
    transform: translateY(-6px) scale(0.97);
  }
}
`,
  'app/components/BrandMark.vue': `<template>
  <span class="shrink-0 font-mono text-[22px] font-normal leading-none" aria-hidden="true"
    >[c]</span
  >
</template>
`,
  'app/components/CloudMascot.vue': `<template>
  <svg
    viewBox="0 0 80 72"
    fill="none"
    shape-rendering="crispEdges"
    aria-hidden="true"
    class="shrink-0"
  >
    <path
      d="M26 8h24v4h8v8h4v8h8v4h4v20h-4v4H10v-4H6V36h4v-4h12V20h4Z"
      class="fill-(--ui-text-highlighted)"
    />
    <path d="M30 12h16v4h8v8h4v8h10v4h2v12h-4v4H14v-4h-4V38h4v-2h12V24h4Z" class="fill-(--ui-bg)" />
    <path d="M14 44h12v4h36v-4h8v4h-4v4H14Z" class="fill-(--ui-bg-accented)" />
    <path d="M32 30h4v8h-4zm16 0h4v8h-4zM38 42h10v4H38z" class="fill-(--ui-text-highlighted)" />
    <path d="M60 10h4v4h4v4h-4v4h-4v-4h-4v-4h4Z" class="fill-orange-500" />
    <path d="M28 64h24v4H28zM22 66h36v2H22z" class="fill-(--ui-border-accented)" />
  </svg>
</template>
`,
  'app/components/CloudconfigLogo.vue': `<template>
  <svg
    viewBox="0 0 80 72"
    fill="none"
    shape-rendering="crispEdges"
    aria-hidden="true"
    class="shrink-0"
  >
    <path
      d="M26 8h24v4h8v8h4v8h8v4h4v20h-4v4H10v-4H6V36h4v-4h12V20h4Z"
      class="fill-(--ui-text-highlighted)"
    />
    <path d="M30 12h16v4h8v8h4v8h10v4h2v12h-4v4H14v-4h-4V38h4v-2h12V24h4Z" class="fill-(--ui-bg)" />
    <path d="M14 44h12v4h36v-4h8v4h-4v4H14Z" class="fill-(--ui-bg-accented)" />
    <path d="M32 30h4v8h-4zm16 0h4v8h-4zM38 42h10v4H38z" class="fill-(--ui-text-highlighted)" />
    <path d="M60 10h4v4h4v4h-4v4h-4v-4h-4v-4h4Z" class="fill-orange-500" />
    <path d="M28 64h24v4H28zM22 66h36v2H22z" class="fill-(--ui-border-accented)" />
  </svg>
</template>
`,
  'app/components/WorkspaceSwitcher.vue': `<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Organization } from '@cloudconfig/core/client'

const props = withDefaults(defineProps<{ collapsed?: boolean }>(), { collapsed: false })

const organizations = useCloudConfigOrganizations()
const activeOrganization = useState<Organization | null>('active-organization', () => null)
const open = ref(false)
const switching = ref(false)
const toast = useToast()
const config = useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined
const requestFetch = useRequestFetch()
const {
  data: items,
  error,
  status,
  refresh,
} = await useAsyncData(
  'workspace-organization',
  async () => {
    const [items, session] = await Promise.all([
      organizations.list(),
      requestFetch<{
        session: { activeOrganizationId?: string | number | null }
      } | null>(\`\${config?.authBasePath ?? '/api/auth'}/get-session\`, {
        query: { disableCookieCache: true },
      }),
    ])
    activeOrganization.value =
      items.find((item) => String(item.id) === String(session?.session.activeOrganizationId)) ??
      null
    return items
  },
  { default: () => [] },
)

function isCloudConfig(organization: Organization | null) {
  return organization?.name.toLowerCase() === 'cloudconfig' || organization?.slug === 'cloudconfig'
}

async function selectWorkspace(id: number | null) {
  if (switching.value) return
  if (id === (activeOrganization.value?.id ?? null)) {
    open.value = false
    return
  }

  switching.value = true
  try {
    activeOrganization.value = await organizations.setActive(id)
    open.value = false
  } catch (cause) {
    toast.add({
      title: 'Could not switch workspace',
      description: cause instanceof Error ? cause.message : 'Please try again.',
      color: 'error',
    })
  } finally {
    switching.value = false
  }
}

interface WorkspaceMenuItem extends DropdownMenuItem {
  slot: 'workspace'
  workspace: Organization | null
}

function workspaceItem(workspace: Organization | null): WorkspaceMenuItem {
  return {
    label: workspace?.name ?? 'Personal workspace',
    workspace,
    slot: 'workspace',
    type: 'checkbox',
    checked: (workspace?.id ?? null) === (activeOrganization.value?.id ?? null),
    disabled: switching.value || status.value === 'pending' || !!error.value,
    class: 'h-10',
    onSelect: (event) => {
      event.preventDefault()
      void selectWorkspace(workspace?.id ?? null)
    },
  }
}

const menu = computed<(DropdownMenuItem | WorkspaceMenuItem)[]>(() => [
  { label: 'Organizations', type: 'label' },
  ...items.value.map(workspaceItem),
  workspaceItem(null),
  { type: 'separator' },
  {
    label: 'Create organization',
    icon: 'i-lucide-plus',
    to: '/dashboard/settings?create=true#organizations',
  },
  {
    label: 'Organization settings',
    icon: 'i-lucide-settings',
    to: '/dashboard/settings#organizations',
  },
])

watch(open, (value) => {
  if (value) void refresh()
})
watch(
  () => props.collapsed,
  () => {
    open.value = false
  },
)
</script>

<template>
  <span class="inline-block w-fit max-w-full self-center align-middle leading-none">
    <UDropdownMenu
      v-model:open="open"
      :items="menu"
      :modal="false"
      :content="{ align: 'start', sideOffset: 4 }"
      :ui="{
        content:
          'z-30 box-border w-58 min-w-0 rounded-[10px] border border-default p-1.5 ring-0 origin-[24px_-16px] opacity-100 translate-y-0 scale-100 [clip-path:inset(0_0_0_0_round_10px)] transition-[clip-path,translate,scale,opacity] [transition-duration:240ms,240ms,240ms,160ms] ease-out starting:opacity-0 starting:-translate-y-1.5 starting:scale-[0.97] starting:[clip-path:inset(0_0_100%_0_round_10px)] data-[state=open]:animate-none data-[state=closed]:animate-[fade-out_160ms_var(--ease-out)] data-[state=closed]:-translate-y-1.5 data-[state=closed]:scale-[0.97] data-[state=closed]:[clip-path:inset(0_0_100%_0_round_10px)] motion-reduce:animate-none motion-reduce:transition-none',
        viewport: 'divide-y-0 scroll-py-0',
        group: 'p-0',
        label: 'gap-0 px-2.5 pt-1.5 pb-1 text-xs leading-[normal] font-normal text-muted',
        item: 'h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-0 text-sm font-normal text-highlighted before:inset-0 before:rounded-md data-highlighted:before:bg-accented data-[state=open]:before:bg-accented',
        itemLeadingIcon: 'size-4 text-muted group-data-highlighted:text-muted',
        itemTrailingIcon: 'size-4 text-highlighted',
        separator: 'mx-1 my-1.5 h-px bg-(--ui-border)',
      }"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="md"
        :square="collapsed"
        :trailing-icon="collapsed ? undefined : 'i-lucide-chevron-down'"
        :label="collapsed ? undefined : (activeOrganization?.name ?? 'Personal workspace')"
        class="h-10 w-auto max-w-full min-w-0 gap-2.5 rounded-lg py-0 pr-2.5 pl-2 text-[15px] leading-[normal] font-medium text-highlighted duration-160 hover:bg-(--gray-300) data-[state=open]:bg-(--gray-300) motion-reduce:transition-none motion-reduce:active:scale-100"
        :ui="{
          label: 'truncate',
          trailingIcon:
            'size-4 text-muted transition-transform duration-240 ease-out motion-reduce:transition-none',
        }"
        :class="{ '[&_[data-slot=trailingIcon]]:rotate-180': open }"
        :aria-busy="switching"
        aria-label="Open organization menu"
      >
        <template #leading>
          <CloudconfigLogo v-if="isCloudConfig(activeOrganization)" class="size-6" />
          <UAvatar
            v-else
            :src="activeOrganization?.logo ?? undefined"
            :alt="activeOrganization?.name ?? 'Personal workspace'"
            :text="(activeOrganization?.name ?? 'Personal workspace').charAt(0).toUpperCase()"
            size="xs"
            :ui="{ root: 'rounded-md bg-(--gray-500)', fallback: 'text-xs font-semibold' }"
          />
        </template>
      </UButton>

      <template #workspace-leading="{ item }">
        <CloudconfigLogo v-if="isCloudConfig(item.workspace ?? null)" class="size-5" />
        <UAvatar
          v-else
          :src="item.workspace?.logo ?? undefined"
          :alt="item.label"
          :text="item.label?.charAt(0).toUpperCase()"
          :ui="{
            root: 'size-5 rounded-[5px] bg-(--gray-500)',
            fallback: 'text-[11px] font-semibold',
          }"
        />
      </template>

      <template #content-bottom>
        <p v-if="error" role="alert" class="px-2.5 py-1.5 text-xs leading-normal text-error">
          Could not load organizations. Reopen the menu to try again.
        </p>
      </template>
    </UDropdownMenu>
  </span>
</template>
`,
  'app/components/SettingsSection.vue': `<script setup lang="ts">
defineProps<{ title: string; description: string }>()
</script>

<template>
  <section
    class="grid gap-x-8 gap-y-4 border-t border-default py-6 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]"
  >
    <div>
      <h2 class="text-[15px] leading-normal font-semibold text-highlighted">{{ title }}</h2>
      <p class="mt-1 text-[13px] leading-normal text-muted">{{ description }}</p>
    </div>
    <div class="grid content-start gap-4">
      <slot />
    </div>
  </section>
</template>
`,
  'app/components/GithubAuthPanel.vue': `<script setup lang="ts">
const { title, description, label } = defineProps<{
  title: string
  description: string
  label: string
}>()

const auth = useCloudConfigAuth()
const busy = ref(false)
const error = ref('')

async function continueWithGithub() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = await auth.signIn.social({ provider: 'github', callbackURL: '/dashboard' })
    if (result.error) throw new Error(result.error.message ?? \`\${label} failed.\`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : \`\${label} failed.\`
    busy.value = false
  }
}
</script>

<template>
  <UCard :title="title" :description="description">
    <UButton
      block
      color="neutral"
      variant="outline"
      :disabled="busy"
      :aria-busy="busy"
      :aria-label="busy ? 'Redirecting to GitHub' : label"
      class="relative overflow-hidden transition-[background-color,color,box-shadow,scale] duration-[240ms,240ms,240ms,120ms] ease-out motion-reduce:transition-none"
      :class="
        busy &&
        'bg-orange-500 text-white ring-orange-500 disabled:cursor-default disabled:bg-orange-500 disabled:opacity-100'
      "
      @click="continueWithGithub"
    >
      <span aria-hidden="true" class="invisible">{{ label }}</span>
      <span
        v-if="busy"
        aria-hidden="true"
        class="absolute inset-y-0 left-0 w-1/2 animate-[carousel_1.8s_ease-in-out_infinite] bg-linear-to-r from-transparent via-white/30 to-transparent transition-opacity duration-500 starting:opacity-0 motion-reduce:hidden"
      />
      <span
        :aria-hidden="busy"
        class="absolute inset-0 flex items-center justify-center gap-1.5 transition-[opacity,translate] duration-[180ms,240ms] ease-out motion-reduce:transition-none"
        :class="busy ? '-translate-y-2 opacity-0' : 'translate-y-0 opacity-100'"
      >
        <UIcon name="i-hugeicons-github" class="size-3.5 shrink-0" />
        <span>{{ label }}</span>
      </span>
      <span
        :aria-hidden="!busy"
        class="absolute inset-0 flex items-center justify-center transition-[opacity,translate] duration-[180ms,240ms] ease-out motion-reduce:transition-none"
        :class="busy ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'"
      >
        Redirecting to GitHub
      </span>
    </UButton>
    <p v-if="error" role="alert" class="mt-2 text-sm text-error">{{ error }}</p>
  </UCard>
</template>
`,
  'app/layouts/default.vue': `<template>
  <main class="grid min-h-screen place-items-center px-4 py-12">
    <div class="w-full max-w-md space-y-6">
      <div class="flex flex-col items-center gap-4">
        <CloudMascot class="h-[90px] w-[100px]" />
        <NuxtLink
          to="/"
          class="flex items-center justify-center gap-2 text-sm font-medium text-muted"
        >
          <BrandMark />
          <span class="mt-1">CloudConfig</span>
        </NuxtLink>
      </div>
      <slot />
    </div>
  </main>
</template>
`,
  'app/layouts/dashboard.vue': `<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const { user, signOut } = useAccountSession()
const route = useRoute()
const colorMode = useColorMode()
const orientation = useDashboardOrientation()

const navigation = DASHBOARD_NAVIGATION
const navigationMenu = navigation.map(({ label, icon, to }) => ({ label, icon, to }))
const collapsed = ref(false)
const topbar = computed(() => orientation.value === 'topbar')
const title = computed(() => {
  if (route.path !== '/dashboard') return (route.meta.title as string | undefined) ?? 'Overview'
  const module = route.query.module
  const prompt = typeof route.query.q === 'string' ? route.query.q : ''
  if (module === 'calendar' || /\\b(calendar|agenda|events?)\\b/i.test(prompt)) return 'Calendar'
  if (module === 'files' || route.query.file) return 'Documents'
  if (module === 'users' || route.query.user) return 'Users'
  return 'Overview'
})

const name = computed(() => user.value?.name || 'User')
const email = computed(() => user.value?.email || '')
const initial = computed(() => name.value.charAt(0).toUpperCase())
const searchGroups = computed(() => [
  {
    id: 'pages',
    label: 'Go to',
    items: navigation.map(({ label, icon, to }) => ({ label, icon, to })),
  },
])

const accountMenu = computed<DropdownMenuItem[][]>(() => [
  [{ label: name.value, description: email.value, type: 'label' }],
  [
    {
      label: 'Navigation',
      icon: topbar.value ? 'i-lucide-panel-top' : 'i-lucide-panel-left',
      children: [
        {
          label: 'Top bar',
          type: 'checkbox',
          checked: topbar.value,
          onSelect: () => (orientation.value = 'topbar'),
        },
        {
          label: 'Sidebar',
          type: 'checkbox',
          checked: !topbar.value,
          onSelect: () => (orientation.value = 'sidebar'),
        },
      ],
    },
    {
      label: 'Theme',
      icon: colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun',
      children: [
        {
          label: 'Dark',
          type: 'checkbox',
          checked: colorMode.preference === 'dark',
          onSelect: () => (colorMode.preference = 'dark'),
        },
        {
          label: 'Light',
          type: 'checkbox',
          checked: colorMode.preference === 'light',
          onSelect: () => (colorMode.preference = 'light'),
        },
      ],
    },
  ],
  [
    {
      label: 'Account security',
      icon: 'i-lucide-shield-check',
      to: '/dashboard/settings#security',
    },
    { label: 'Settings', icon: 'i-lucide-settings', to: '/dashboard/settings' },
    { label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut },
  ],
])
</script>

<template>
  <UDashboardGroup id="cloudconfig-dashboard" unit="rem" :class="topbar ? 'flex-col' : undefined">
    <!-- Top bar: one 56px row, as in the design -->
    <header v-if="topbar" class="shrink-0 border-b border-default bg-default">
      <div
        class="mx-auto flex h-(--ui-header-height) max-w-7xl items-center justify-between gap-4 px-4 sm:px-6"
      >
        <div class="flex min-w-0 items-center gap-1.5">
          <WorkspaceSwitcher />
          <UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
          <UDropdownMenu :items="[navigationMenu]" :content="{ align: 'start' }">
            <UButton
              color="neutral"
              variant="ghost"
              :label="title"
              trailing-icon="i-lucide-chevron-down"
              class="h-8 gap-2 px-2 text-sm font-normal"
              aria-label="Current page navigation"
            />
          </UDropdownMenu>
        </div>

        <div class="flex items-center gap-2">
          <UButton
            variant="ghost"
            size="md"
            square
            icon="i-lucide-bell"
            aria-label="Notifications"
          />
          <UDropdownMenu :items="accountMenu" :content="{ align: 'end' }">
            <button type="button" class="ms-1 cursor-pointer rounded-full" aria-label="Account">
              <UAvatar :alt="name" :text="initial" size="sm" class="bg-(--gray-600)" />
            </button>
          </UDropdownMenu>
        </div>
      </div>
    </header>

    <!-- Sidebar -->
    <UDashboardSidebar
      v-else
      id="cloudconfig-dashboard"
      v-model:collapsed="collapsed"
      collapsible
      :min-size="15.5"
      :default-size="15.5"
      :max-size="15.5"
      :collapsed-size="3.5"
      :ui="{ root: 'data-[collapsed=false]:w-62' }"
    >
      <template #header="{ collapsed: isCollapsed }">
        <WorkspaceSwitcher :collapsed="isCollapsed" />
      </template>

      <template #default="{ collapsed: isCollapsed }">
        <div class="flex flex-1 flex-col p-2">
          <UNavigationMenu
            :items="navigation"
            :collapsed="isCollapsed"
            orientation="vertical"
            tooltip
          />
        </div>
      </template>

      <template #footer="{ collapsed: isCollapsed }">
        <UDropdownMenu :items="accountMenu" :content="{ align: 'start', side: 'top' }">
          <UButton
            variant="ghost"
            :square="isCollapsed"
            class="h-11 w-full gap-2 px-2"
            :class="isCollapsed ? 'justify-center' : 'justify-start'"
            :aria-label="isCollapsed ? 'Open account menu' : undefined"
          >
            <UAvatar :alt="name" :text="initial" size="sm" class="bg-(--gray-600)" />
            <span v-if="!isCollapsed" class="min-w-0 flex-1 text-left leading-tight">
              <span class="block truncate text-[13px] font-medium text-highlighted">{{
                name
              }}</span>
              <span class="block truncate text-xs font-normal text-muted">{{ email }}</span>
            </span>
            <UIcon v-if="!isCollapsed" name="i-lucide-chevrons-up-down" class="size-4" />
          </UButton>
        </UDropdownMenu>
      </template>
    </UDashboardSidebar>

    <main class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <UDashboardNavbar v-if="!topbar" :title="title">
        <template #leading>
          <UDashboardSidebarCollapse />
          <USeparator orientation="vertical" />
        </template>
        <template #right>
          <UButton
            variant="ghost"
            size="md"
            square
            icon="i-lucide-bell"
            aria-label="Notifications"
          />
        </template>
      </UDashboardNavbar>

      <slot />
    </main>

    <UDashboardSearch :groups="searchGroups" />
  </UDashboardGroup>
</template>
`,
  'app/composables/useCurrentUser.ts': `export interface CurrentUser {
  id: string | number
  name: string
  email: string
}

/** The signed-in account, shared across the app and seeded by the \`auth\` middleware. */
export function useCurrentUser() {
  return useState<CurrentUser | null>('current-user', () => null)
}

/** Reads the session from the mounted auth routes, forwarding the caller's cookies. */
export async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const config = useRuntimeConfig().public.cloudconfig as { authBasePath?: string } | undefined
  const session = await useRequestFetch()<{ user: CurrentUser } | null>(
    \`\${config?.authBasePath ?? '/api/auth'}/get-session\`,
    { query: { disableCookieCache: true } },
  )
  return session?.user ?? null
}

/**
 * The account behind the dashboard shell.
 *
 * The middleware seeds {@link useCurrentUser} during SSR; this keeps it in step
 * with sign-in and sign-out that happen after hydration.
 */
export function useAccountSession() {
  const user = useCurrentUser()
  const auth = useCloudConfigAuth()
  const session = auth.useSession()

  onMounted(() => {
    watch(
      session,
      ({ isPending, error, data }) => {
        if (!isPending && !error) user.value = data?.user ?? null
      },
      { immediate: true },
    )
  })

  async function signOut() {
    const { error } = await auth.signOut()
    if (error) return
    user.value = null
    await navigateTo('/sign-in')
  }

  return { user, signOut }
}
`,
  'app/composables/useDashboardLayout.ts': `import type { NavigationMenuItem } from '@nuxt/ui'

export type DashboardOrientation = 'sidebar' | 'topbar'

/** Sidebar or top-bar navigation, kept in a cookie so SSR renders the right shell. */
export function useDashboardOrientation() {
  return useCookie<DashboardOrientation>('dashboard-orientation', {
    default: () => 'topbar',
    maxAge: 60 * 60 * 24 * 365,
  })
}

/** The pages both shells link to. */
export const DASHBOARD_NAVIGATION: NavigationMenuItem[] = [
  { label: 'Overview', icon: 'i-lucide-sparkles', to: '/dashboard', exact: true },
]
`,
  'app/composables/useDashboardPreferences.ts': `export interface DashboardPreferences {
  defaultModel: 'Fast' | 'Balanced' | 'Deep'
  emailNotifications: boolean
  weeklyDigest: boolean
  autoAdvance: boolean
}

export function useDashboardPreferences() {
  const user = useCurrentUser()
  return useCookie<DashboardPreferences>(\`dashboard-preferences:\${user.value?.id ?? 'guest'}\`, {
    default: () => ({
      defaultModel: 'Balanced',
      emailNotifications: true,
      weeklyDigest: false,
      autoAdvance: true,
    }),
    maxAge: 60 * 60 * 24 * 365,
  })
}
`,
  'app/middleware/auth.ts': `function isHydratingServerRender(): boolean {
  const app = useNuxtApp()
  return import.meta.client && app.isHydrating === true && app.payload.serverRendered === true
}

export default defineNuxtRouteMiddleware(async () => {
  const user = useCurrentUser()
  if (isHydratingServerRender() && user.value) return

  user.value = await fetchCurrentUser().catch(() => null)
  if (!user.value) return navigateTo('/sign-in')
})
`,
  'app/pages/index.vue': `<script setup lang="ts">
await navigateTo('/dashboard')
</script>

<template><span /></template>
`,
  'app/pages/sign-in.vue': `<template>
  <div>
    <GithubAuthPanel
      title="Sign in"
      description="Continue with GitHub to use CloudConfig."
      label="Continue with GitHub"
    />
    <p class="mt-5 text-center text-sm text-muted">
      Need an account?
      <NuxtLink
        to="/sign-up"
        class="font-medium text-highlighted underline-offset-4 hover:underline"
      >
        Sign up
      </NuxtLink>
    </p>
  </div>
</template>
`,
  'app/pages/sign-up.vue': `<template>
  <div>
    <GithubAuthPanel
      title="Create an account"
      description="Continue with GitHub to create your CloudConfig account."
      label="Sign up with GitHub"
    />
    <p class="mt-5 text-center text-sm text-muted">
      Already have an account?
      <NuxtLink
        to="/sign-in"
        class="font-medium text-highlighted underline-offset-4 hover:underline"
      >
        Sign in
      </NuxtLink>
    </p>
  </div>
</template>
`,
  'app/pages/two-factor.vue': `<script setup lang="ts">
import type { TwoFactorStatus } from '@cloudconfig/core/client'

const auth = useCloudConfigTwoFactor()
const account = useCloudConfigAccount()
const user = useCurrentUser()
const status = ref<TwoFactorStatus | null>(null)
const code = ref('')
const busy = ref(false)
const error = ref('')
const message = ref('')

async function sendCode() {
  const result = await auth.twoFactor.sendOtp({})
  if (result.error) throw new Error(result.error.message ?? 'Could not send the verification code.')
  message.value = 'We sent a six-digit code to the email address on your account.'
}

async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Could not complete verification. Try again.'
  } finally {
    busy.value = false
  }
}

onMounted(() =>
  run(async () => {
    status.value = await account.getTwoFactorStatus()
    if (!status.value.pending) {
      await navigateTo('/dashboard')
      return
    }
    if (status.value.method === 'email') await sendCode()
  }),
)

function verify() {
  return run(async () => {
    const result =
      status.value?.method === 'passkey'
        ? await auth.signIn.passkey()
        : await auth.twoFactor.verifyOtp({ code: code.value })
    if (result.error) throw new Error(result.error.message ?? 'Verification failed. Try again.')
    const session = await auth.getSession({ query: { disableCookieCache: true } })
    if (session.error || !session.data)
      throw new Error('Could not read your verified session. Sign in again.')
    user.value = session.data.user
    await navigateTo('/dashboard')
  })
}
</script>

<template>
  <section class="w-full space-y-5">
    <div class="text-center">
      <h1 class="text-2xl font-medium text-highlighted">Verify your sign-in</h1>
      <p class="mt-2 text-sm text-muted">
        {{
          status?.method === 'passkey'
            ? 'Use your passkey to finish signing in.'
            : 'Enter the verification code sent to your email.'
        }}
      </p>
    </div>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="message" role="status" class="text-sm text-muted">{{ message }}</p>
    <form
      v-if="status?.pending && status.method === 'email'"
      class="space-y-4"
      @submit.prevent="verify"
    >
      <UFormField label="Verification code">
        <UInput
          v-model="code"
          autocomplete="one-time-code"
          inputmode="numeric"
          pattern="[0-9]{6}"
          maxlength="6"
          required
          autofocus
          :disabled="busy"
          class="w-full"
        />
      </UFormField>
      <UButton block type="submit" label="Verify" :loading="busy" :disabled="code.length !== 6" />
      <UButton
        block
        label="Resend code"
        color="neutral"
        variant="link"
        :disabled="busy"
        @click="run(sendCode)"
      />
    </form>
    <UButton
      v-if="status?.pending && status.method === 'passkey'"
      block
      label="Verify with passkey"
      :loading="busy"
      @click="verify"
    />
    <NuxtLink
      to="/sign-in"
      class="block text-center text-sm text-muted underline-offset-4 hover:underline"
      >Sign in again</NuxtLink
    >
  </section>
</template>
`,
  ...NUXT_USERS_TEMPLATE,
  ...NUXT_ACCOUNT_TEMPLATE,
} as const

export type NuxtDashboardTemplatePath = keyof typeof NUXT_DASHBOARD_TEMPLATE
