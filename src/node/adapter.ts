import { DatabaseSync } from 'node:sqlite'
import type { SQLiteAdapter } from '../adapters/interface.js'

export class NodeSQLiteAdapter implements SQLiteAdapter {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec('PRAGMA foreign_keys=ON')
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql)
    return stmt.all(...(params as Parameters<typeof stmt.all>)) as T[]
  }

  async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (params.length === 0) {
      this.db.exec(sql)
    } else {
      const stmt = this.db.prepare(sql)
      stmt.run(...(params as Parameters<typeof stmt.run>))
    }
  }

  async transaction(fn: () => Promise<void>): Promise<void> {
    this.db.exec('BEGIN')
    try {
      await fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  close(): void {
    this.db.close()
  }
}
