import type { SQLiteAdapter } from '../adapters/interface.js'
import type { DBMeta, TableMeta } from './types.js'

export async function loadDBMeta(db: SQLiteAdapter): Promise<DBMeta> {
  const names = await listTables(db)
  const deps = await buildDependencies(db, names)
  const sorted = topoSort(names, deps)

  const tables: TableMeta[] = []
  const tableIndex = new Map<string, number>()

  for (const name of sorted) {
    const columns = await tableColumns(db, name)
    const primaryKey = await tablePrimaryKey(db, name)
    tableIndex.set(name, tables.length)
    tables.push({ name, columns, primaryKey })
  }

  return { tables, tableIndex }
}

export function tableByName(meta: DBMeta, name: string): TableMeta | undefined {
  const i = meta.tableIndex.get(name)
  return i !== undefined ? meta.tables[i] : undefined
}

async function listTables(db: SQLiteAdapter): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\'`
  )
  return rows.map(r => r.name)
}

async function tableColumns(db: SQLiteAdapter, table: string): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `PRAGMA table_info(${JSON.stringify(table)})`
  )
  return rows.map(r => r.name)
}

async function tablePrimaryKey(db: SQLiteAdapter, table: string): Promise<string[]> {
  const rows = await db.query<{ name: string; pk: number }>(
    `PRAGMA table_info(${JSON.stringify(table)})`
  )
  return rows
    .filter(r => r.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(r => r.name)
}

async function buildDependencies(
  db: SQLiteAdapter,
  tables: string[]
): Promise<Map<string, string[]>> {
  const deps = new Map<string, string[]>()
  for (const table of tables) {
    deps.set(table, [])
  }

  for (const table of tables) {
    const fks = await db.query<{ table: string }>(
      `PRAGMA foreign_key_list(${JSON.stringify(table)})`
    )
    for (const fk of fks) {
      deps.get(table)!.push(fk.table)
    }
  }

  return deps
}

// Kahn's algorithm — deps[t] is the list of tables t depends on (FK targets)
function topoSort(tables: string[], deps: Map<string, string[]>): string[] {
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const table of tables) {
    if (!inDegree.has(table)) inDegree.set(table, 0)
    for (const dep of deps.get(table) ?? []) {
      inDegree.set(table, (inDegree.get(table) ?? 0) + 1)
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(table)
    }
  }

  const queue = tables.filter(t => inDegree.get(t) === 0)
  const result: string[] = []

  while (queue.length > 0) {
    const table = queue.shift()!
    result.push(table)
    for (const dependent of dependents.get(table) ?? []) {
      const newDegree = (inDegree.get(dependent) ?? 0) - 1
      inDegree.set(dependent, newDegree)
      if (newDegree === 0) queue.push(dependent)
    }
  }

  if (result.length !== tables.length) {
    throw new Error('Cycle detected in schema foreign key graph')
  }

  return result
}
