import {
  readDurableRecord,
  withDurableLease,
  writeDurableRecord,
  type DurableRecordStore,
} from './records.js'

export interface DurableDispatcher<Run, Schedule> {
  startRun(input: Run): Promise<string>
  startSchedule(input: Schedule): Promise<string>
  isActive(executionId: string): Promise<boolean>
  wake(executionId: string): Promise<void>
  cancel(executionId: string): Promise<void>
}

/** Persist a native execution pointer independently of a request's lifetime. */
export async function ensureDurableExecution(options: {
  records: DurableRecordStore
  key: string
  start: () => Promise<string>
  isActive: (id: string) => Promise<boolean>
  wake?: (id: string) => Promise<void>
}): Promise<void> {
  const { records, key } = options
  const accepted = await withDurableLease(records, key, async () => {
    const previous = await readDurableRecord<{ id: string }>(records, key)
    if (previous && (await options.isActive(previous.id))) {
      await options.wake?.(previous.id)
      return true
    }
    const id = await options.start()
    await writeDurableRecord<{ id: string }>(records, key, () => ({ id }))
    return true
  })
  if (!accepted) {
    throw new Error('Another request is starting this run. Retry with the same run ID.')
  }
}
