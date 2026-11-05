import { createTable, type TableQuery, type TableSource } from '@cloudconfig/core/client'
import { shallowRef, onScopeDispose, useAsyncData } from '#imports'

/** Give independent tables distinct keys; Nuxt transfers initial results and errors through its SSR payload. */
export function useCloudConfigTable<Row, Create, Update, Key extends string>(
  key: string,
  source: TableSource<Row, Create, Update, Key>,
  query: NoInfer<TableQuery<Key>> = {},
) {
  const controller = createTable(source, query)
  const state = shallowRef(controller.state)
  const unsubscribe = controller.subscribe((value) => {
    state.value = value
  })
  onScopeDispose(() => {
    unsubscribe()
    controller.dispose()
  })
  const initial = useAsyncData(`cloudconfig:table:${key}`, async () => {
    await controller.refresh()
    const { result, query, error } = controller.state
    // Return a plain payload even on failure: Nuxt must hydrate the same table
    // state instead of swallowing the controller's error in AsyncData.error.
    return {
      result,
      query,
      error: error
        ? {
            message: error.message,
            status: 'status' in error && typeof error.status === 'number' ? error.status : null,
          }
        : null,
    }
  })
  const ready = initial.then((value) => {
    const snapshot = value.data.value
    if (snapshot) {
      const error = snapshot.error
        ? Object.assign(new Error(snapshot.error.message), {
            status: snapshot.error.status,
          })
        : null
      controller.hydrate(snapshot.result, error, snapshot.query)
    }
  })
  return { ...controller, state, ready }
}
