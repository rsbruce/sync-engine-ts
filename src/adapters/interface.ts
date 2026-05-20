export interface SQLiteAdapter {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string, params?: unknown[]): Promise<void>
  transaction(fn: () => Promise<void>): Promise<void>
}
