import type { SQLiteAdapter } from '../adapters/interface.js'
import type { ValidationError } from './types.js'

export async function validate(
  db: SQLiteAdapter,
  schemaSQL: string
): Promise<ValidationError[]> {
  await db.exec(schemaSQL)

  const tables = await listTables(db)
  const errors: ValidationError[] = []

  for (const table of tables) {
    errors.push(...(await checkColumns(db, table)))
    errors.push(...(await checkPrimaryKey(db, table)))
    errors.push(...(await checkNoUniqueIndexes(db, table)))
    errors.push(...(await checkForeignKeys(db, table)))
  }

  return errors
}

async function listTables(db: SQLiteAdapter): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
  )
  return rows.map(r => r.name)
}

async function checkColumns(db: SQLiteAdapter, table: string): Promise<ValidationError[]> {
  const rows = await db.query<{ name: string; type: string }>(
    `PRAGMA table_info(${JSON.stringify(table)})`
  )

  const required: Record<string, boolean> = {
    created_at: false,
    updated_at: false,
    deleted_at: false,
  }

  for (const row of rows) {
    if (row.name in required) {
      if (row.type.toLowerCase() !== 'integer') {
        return [{ table, message: `column "${row.name}" must be type integer, got "${row.type}"` }]
      }
      required[row.name] = true
    }
  }

  return Object.entries(required)
    .filter(([, found]) => !found)
    .map(([col]) => ({ table, message: `missing required column "${col}"` }))
}

async function checkPrimaryKey(db: SQLiteAdapter, table: string): Promise<ValidationError[]> {
  const rows = await db.query<{ pk: number }>(
    `PRAGMA table_info(${JSON.stringify(table)})`
  )
  const hasPK = rows.some(r => r.pk > 0)
  return hasPK ? [] : [{ table, message: 'table must have a primary key' }]
}

async function checkNoUniqueIndexes(db: SQLiteAdapter, table: string): Promise<ValidationError[]> {
  const rows = await db.query<{ name: string; unique: number; origin: string }>(
    `PRAGMA index_list(${JSON.stringify(table)})`
  )
  return rows
    .filter(r => r.unique === 1 && r.origin !== 'pk')
    .map(r => ({
      table,
      message: `unique index "${r.name}" is not allowed; use a composite primary key instead`,
    }))
}

async function checkForeignKeys(db: SQLiteAdapter, table: string): Promise<ValidationError[]> {
  const rows = await db.query<{ from: string; on_delete: string }>(
    `PRAGMA foreign_key_list(${JSON.stringify(table)})`
  )
  return rows
    .filter(r => r.on_delete.toUpperCase() !== 'CASCADE')
    .map(r => ({
      table,
      message: `foreign key on column "${r.from}" must have ON DELETE CASCADE`,
    }))
}
