export interface TableMeta {
  name: string
  columns: string[]
  primaryKey: string[]
}

export interface DBMeta {
  // Tables in topological order: parents before children
  tables: TableMeta[]
  tableIndex: Map<string, number>
}

export interface ValidationError {
  table: string
  message: string
}

export type SyncRow = { table: string } & Record<string, unknown>

export interface SyncState {
  [tableName: string]: number
}

// Shape of the single /sync request body
export interface SyncRequest {
  userId: string
  schemaId: string
  state: SyncState
  rows: SyncRow[]
}

// Shape of the single /sync response
export interface SyncResponse {
  rows: SyncRow[]
  state: SyncState
}
