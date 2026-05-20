import type { SQLiteAdapter } from '../adapters/interface.js'

// The promiser function returned by sqlite3Worker1Promiser
type Promiser = (command: string, args: Record<string, unknown>) => Promise<{
  result: {
    resultRows?: Record<string, unknown>[]
    [key: string]: unknown
  }
}>

export class BrowserSQLiteAdapter implements SQLiteAdapter {
  private promiser: Promiser
  private dbId: string

  constructor(promiser: Promiser, dbId: string) {
    this.promiser = promiser
    this.dbId = dbId
  }

  // Open (or create) a database and return a ready adapter.
  // filename should use OPFS format: 'file:mydb.sqlite3?vfs=opfs'
  static async open(promiser: Promiser, filename: string): Promise<BrowserSQLiteAdapter> {
    const { result } = await promiser('open', { filename })
    const dbId = result.dbId as string
    return new BrowserSQLiteAdapter(promiser, dbId)
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { result } = await this.promiser('exec', {
      dbId: this.dbId,
      sql,
      bind: params,
      rowMode: 'object',
      returnValue: 'resultRows',
    })
    return (result.resultRows ?? []) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    await this.promiser('exec', {
      dbId: this.dbId,
      sql,
      bind: params,
    })
  }

  async transaction(fn: () => Promise<void>): Promise<void> {
    await this.exec('BEGIN')
    try {
      await fn()
      await this.exec('COMMIT')
    } catch (e) {
      await this.exec('ROLLBACK')
      throw e
    }
  }
}
