/** Structural port; this module stays importable on Node, AWS and Azure hosts. */
export interface AgentNamespace<T> {
  idFromName(name: string): unknown
  get(id: unknown): T
}

export async function agentStub<T>(binding: unknown, name: string): Promise<T> {
  const namespace = binding as AgentNamespace<T> | undefined
  if (!namespace?.idFromName || !namespace.get) {
    throw new Error('The Agent binding is missing. Run cloudconfig deploy to provision it.')
  }
  // The official routing helper initializes SDK lifecycle capabilities before RPC.
  // Keep it separate from portable scheduling helpers so unrelated builds omit the SDK.
  const { getAgentByName } = await import('agents/routing')
  return (await getAgentByName(namespace as never, name)) as T
}
