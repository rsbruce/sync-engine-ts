import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { validate } from '../core/validate.js'
import { SyncEngine, SyncError } from '../core/sync.js'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { SyncRequest } from '../core/types.js'
import { NodeSQLiteAdapter } from './adapter.js'

interface ServerOptions {
  userDataDir: string
  schemasDir: string
  allowedOrigins?: string | string[]
}

export function createSyncServer(options: ServerOptions): Hono {
  const { userDataDir, schemasDir, allowedOrigins = '*' } = options
  const app = new Hono()

  app.use('*', cors({ origin: allowedOrigins, allowHeaders: ['*'] }))

  app.use('*', async (c, next) => {
    await next()
    console.log(`${c.req.method} ${c.req.path} ${c.res.status}`)
  })

  // Create a user's database, applying and validating the schema
  app.post('/databases', async (c) => {
    const { user_id: userId, schema_id: schemaId } = await c.req.json()

    if (!userId || !schemaId) {
      return c.json({ error: 'user_id and schema_id are required' }, 400)
    }

    const schemaPath = join(schemasDir, `${schemaId}.sql`)
    if (!existsSync(schemaPath)) {
      return c.json({ error: 'schema not found' }, 404)
    }

    const schemaSQL = readFileSync(schemaPath, 'utf8')
    const dbDir = join(userDataDir, schemaId)
    const dbPath = join(dbDir, `${userId}.sqlite`)

    if (existsSync(dbPath)) {
      return c.json({ error: 'database already exists' }, 409)
    }

    // Validate schema in memory before creating the real DB
    const memAdapter = new NodeSQLiteAdapter(':memory:')
    const errors = await validate(memAdapter, schemaSQL)
    memAdapter.close()

    if (errors.length > 0) {
      return c.json({ errors }, 400)
    }

    mkdirSync(dbDir, { recursive: true })
    const adapter = new NodeSQLiteAdapter(dbPath)
    await adapter.exec(schemaSQL)
    adapter.close()

    return c.json({}, 201)
  })

  // Single symmetric sync endpoint
  app.post('/sync', async (c) => {
    const body = await c.req.json() as SyncRequest

    if (!body.userId || !body.schemaId) {
      return c.json({ error: 'userId and schemaId are required' }, 400)
    }

    const dbPath = join(userDataDir, body.schemaId, `${body.userId}.sqlite`)
    if (!existsSync(dbPath)) {
      return c.json({ error: 'database not found' }, 404)
    }

    const adapter = new NodeSQLiteAdapter(dbPath)
    const engine = new SyncEngine(adapter, body.schemaId)
    await engine.init()

    try {
      const response = await engine.applyAndQuery(body)
      return c.json(response)
    } catch (e) {
      if (e instanceof SyncError) {
        return c.json({ error: e.message }, e.status as ContentfulStatusCode)
      }
      throw e
    } finally {
      adapter.close()
    }
  })

  return app
}
