/** Durable compare-and-set storage. Versions fence concurrent workers and stale writes. */
export interface DurableRecordStore {
  read(key: string): Promise<{ value: string; version: string } | null>
  create(key: string, value: string): Promise<boolean>
  replace(key: string, value: string, version: string): Promise<boolean>
}

export async function readDurableRecord<T>(
  store: DurableRecordStore,
  key: string,
): Promise<T | null> {
  const record = await store.read(key)
  return record ? JSON.parse(record.value) : null
}

/** Retry only conditional writes, never application side effects. */
export async function writeDurableRecord<T>(
  store: DurableRecordStore,
  key: string,
  update: (current: T | null) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const current = await store.read(key)
    const value = update(current ? JSON.parse(current.value) : null)
    const encoded = JSON.stringify(value)
    const saved = current
      ? await store.replace(key, encoded, current.version)
      : await store.create(key, encoded)
    if (saved) return value
  }
  throw new Error('Concurrent durable updates did not settle. Retry the operation.')
}

interface Lease {
  owner: string
  expiresAt: number
}
const LEASE_MS = 240_000

/** A lease outlives the bounded activity. A crashed worker leaves receipts for recovery. */
export async function withDurableLease<T>(
  store: DurableRecordStore,
  key: string,
  work: (assertOwner: () => Promise<void>) => Promise<T>,
): Promise<T | undefined> {
  const leaseKey = `${key}:lease`
  const owner = crypto.randomUUID()
  const current = await store.read(leaseKey)
  const previous: Lease | null = current ? JSON.parse(current.value) : null
  if (previous && previous.expiresAt > Date.now()) return
  const lease: Lease = { owner, expiresAt: Date.now() + LEASE_MS }
  const claimed = current
    ? await store.replace(leaseKey, JSON.stringify(lease), current.version)
    : await store.create(leaseKey, JSON.stringify(lease))
  if (!claimed) return
  async function assertOwner() {
    const active = await readDurableRecord<Lease>(store, leaseKey)
    if (active?.owner !== owner || active.expiresAt <= Date.now()) {
      throw new Error('The durable activity lease expired; a stale worker cannot write results.')
    }
  }
  try {
    return await work(assertOwner)
  } finally {
    const latest = await store.read(leaseKey)
    if (latest && (JSON.parse(latest.value) as Lease).owner === owner) {
      await store.replace(leaseKey, JSON.stringify({ owner, expiresAt: 0 }), latest.version)
    }
  }
}
