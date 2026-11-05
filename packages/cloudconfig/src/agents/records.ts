/** Compatibility names for the shared durable execution store. */
export {
  type DurableRecordStore as AgentRecordStore,
  readDurableRecord as readAgentRecord,
  writeDurableRecord as writeAgentRecord,
  withDurableLease as withAgentLease,
} from '../durable/records.js'
