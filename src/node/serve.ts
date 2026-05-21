import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { createSyncServer } from './server.js'

const port = Number(process.env.PORT ?? 9000)
const userDataDir = process.env.USER_DATA_DIR ?? join(process.cwd(), 'data', 'users')
const schemasDir = process.env.SCHEMAS_DIR ?? join(process.cwd(), 'data', 'schemas')

const app = createSyncServer({ userDataDir, schemasDir })

serve({ fetch: app.fetch, port }, () => {
  console.log(`Sync server running on http://localhost:${port}`)
})
