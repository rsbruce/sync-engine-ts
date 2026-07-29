import type { SQLiteAdapter } from '../adapters/interface.js'
import { loadDBMeta, tableByName } from './schema.js'
import type { DBMeta, SyncRequest, SyncResponse, SyncResult, SyncRow, SyncState, TableMeta } from './types.js'

const SYNC_STATE_TABLE = '_sync_state'

export class SyncEngine {
  private db: SQLiteAdapter
  private schemaId: string
  private meta: DBMeta | null = null

  constructor(db: SQLiteAdapter, schemaId: string) {
    this.db = db
    this.schemaId = schemaId
  }

  async init(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SYNC_STATE_TABLE} (
        table_name TEXT PRIMARY KEY,
        last_synced_at INTEGER NOT NULL DEFAULT 0
      )
    `)
    this.meta = await loadDBMeta(this.db)
  }

  async sync(serverUrl: string, userId: string, accessToken?: string): Promise<SyncResult> {
    const meta = this.requireMeta()
    const state = await this.readSyncState(meta)
    const rows = await this.collectRowsToPush(meta, state)

    const body: SyncRequest = {
      userId,
      schemaId: this.schemaId,
      state,
      rows,
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`

    const response = await fetch(`${serverUrl}/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      // Carry the HTTP status so callers can react (e.g. refresh on 401).
      const error = new Error(`Sync failed: ${response.status} ${await response.text()}`) as Error & {
        status?: number
      }
      error.status = response.status
      throw error
    }

    const { rows: incomingRows, state: serverState }: SyncResponse = await response.json()

    await this.db.transaction(async () => {
      await this.applyRows(meta, incomingRows)
      await this.updateSyncState(meta, serverState)
    })

    return { pushed: rows.length, pulled: incomingRows.length }
  }

  // Called by the server-side handler to apply a client's push and return a delta.
  async applyAndQuery(request: SyncRequest): Promise<SyncResponse> {
    const meta = this.requireMeta()

    // Validate all table names before touching the DB
    for (const row of request.rows) {
      if (!tableByName(meta, row.table)) {
        throw new SyncError(`Unknown table "${row.table}"`, 400)
      }
    }

    let serverRows: SyncRow[] = []
    let serverState: SyncState = {}

    await this.db.transaction(async () => {
      await this.applyRows(meta, request.rows)
      serverRows = await this.collectRowsToPush(meta, request.state)
      serverState = await this.computeWatermarks(meta)
    })

    return { rows: serverRows, state: serverState }
  }

  // The state returned to the client is the max updated_at per table AFTER the
  // client's rows have been applied — i.e. a watermark covering both the rows
  // we just returned and the rows the client just pushed. The client stores it
  // and sends it back next sync, so both sides then only exchange rows newer
  // than the watermark. (The server's own _sync_state table is never written;
  // deriving state from it would pin every watermark at 0 and make each sync
  // transfer the full database.)
  private async computeWatermarks(meta: DBMeta): Promise<SyncState> {
    const state: SyncState = {}
    for (const table of meta.tables) {
      const rows = await this.db.query<{ ts: number | null }>(
        `SELECT MAX(updated_at) AS ts FROM "${table.name}"`
      )
      state[table.name] = rows[0]?.ts ?? 0
    }
    return state
  }

  private async readSyncState(meta: DBMeta): Promise<SyncState> {
    const rows = await this.db.query<{ table_name: string; last_synced_at: number }>(
      `SELECT table_name, last_synced_at FROM ${SYNC_STATE_TABLE}`
    )
    const state: SyncState = {}
    for (const table of meta.tables) {
      state[table.name] = 0
    }
    for (const row of rows) {
      state[row.table_name] = row.last_synced_at
    }
    return state
  }

  private async updateSyncState(meta: DBMeta, incoming: SyncState): Promise<void> {
    const current = await this.readSyncState(meta)
    for (const [table, ts] of Object.entries(incoming)) {
      const newTs = Math.max(current[table] ?? 0, ts)
      await this.db.exec(
        `INSERT INTO ${SYNC_STATE_TABLE} (table_name, last_synced_at) VALUES (?, ?)
         ON CONFLICT(table_name) DO UPDATE SET last_synced_at = ?`,
        [table, newTs, newTs]
      )
    }
  }

  private async collectRowsToPush(meta: DBMeta, since: SyncState): Promise<SyncRow[]> {
    const rows: SyncRow[] = []
    for (const table of meta.tables) {
      const sinceTs = since[table.name] ?? 0
      const cols = table.columns.map(c => `"${c}"`).join(', ')
      // When sinceTs=0 (first sync), send every row regardless of timestamps —
      // guards against rows that have null or zero timestamps (e.g. from
      // positional INSERTs where column order didn't match the schema).
      const [sql, params] = sinceTs === 0
        ? [`SELECT ${cols} FROM "${table.name}" ORDER BY COALESCE(updated_at, 0) ASC`, []]
        : [`SELECT ${cols} FROM "${table.name}" WHERE updated_at > ? OR created_at > ? ORDER BY updated_at ASC`, [sinceTs, sinceTs]]
      const tableRows = await this.db.query<Record<string, unknown>>(sql, params)
      for (const row of tableRows) {
        rows.push({ table: table.name, ...row })
      }
    }
    return rows
  }

  private async applyRows(meta: DBMeta, rows: SyncRow[]): Promise<void> {
    // Group by table, preserving order within each group
    const grouped = new Map<string, Record<string, unknown>[]>()
    for (const row of rows) {
      const { table, ...data } = row
      if (!grouped.has(table)) grouped.set(table, [])
      grouped.get(table)!.push(data)
    }

    // Process in topo order
    for (const tableMeta of meta.tables) {
      const tableRows = grouped.get(tableMeta.name)
      if (!tableRows) continue
      const query = buildUpsertQuery(tableMeta)
      for (const row of tableRows) {
        const values = tableMeta.columns.map(col => row[col] ?? null)
        try {
          await this.db.exec(query, values)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new Error(`${msg} — table: "${tableMeta.name}", row: ${JSON.stringify(row)}`)
        }
      }
    }
  }

  private requireMeta(): DBMeta {
    if (!this.meta) throw new Error('SyncEngine not initialised — call init() first')
    return this.meta
  }
}

function buildUpsertQuery(table: TableMeta): string {
  const cols = table.columns.map(c => `"${c}"`).join(', ')
  const placeholders = table.columns.map(() => '?').join(', ')
  const setClauses = table.columns.map(c => `"${c}" = excluded."${c}"`).join(', ')
  const conflictCols = table.primaryKey.map(c => `"${c}"`).join(', ')

  return `INSERT INTO "${table.name}" (${cols}) VALUES (${placeholders})
    ON CONFLICT(${conflictCols}) DO UPDATE SET ${setClauses}
    WHERE excluded.updated_at > "${table.name}".updated_at`
}

export class SyncError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}
