import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { RelaySession } from './relay-session.mjs'

const app = new Hono()
app.use(logger())

// 1. Endpoint for Plover (PC) to create a new session
app.post('/session/initiate', async (c) => {
  const { RELAY_SESSION } = c.env

  const sessionId = crypto.randomUUID()
  const secretToken = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const sessionIdFromName = RELAY_SESSION.idFromName(sessionId)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Initialize the Durable Object
  await sessionStub.fetch(new Request(c.req.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secretToken })
  }))

  const workerUrl = new URL(c.req.url)
  const wssBaseUrl = `wss://${workerUrl.hostname}`
  const tabletConnectionUrl = `${wssBaseUrl}/session/${sessionId}/join?token=${secretToken}`

  return c.json({
    sessionId,
    tabletConnectionUrl
  })
})

// 2. WebSocket endpoint for the Tablet to JOIN
app.get('/session/:id/join', async (c) => {
  // IMPORTANT: Just forward the raw request - NO upgrade check here!
  const { id } = c.req.param()
  const { RELAY_SESSION } = c.env
  const sessionIdFromName = RELAY_SESSION.idFromName(id)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Forward the COMPLETE original request
  return sessionStub.fetch(c.req.raw)
})

// 3. WebSocket endpoint for the PC to CONNECT
app.get('/session/:id/connect', async (c) => {
  // IMPORTANT: Just forward the raw request - NO upgrade check here!
  const { id } = c.req.param()
  const { RELAY_SESSION } = c.env
  const sessionIdFromName = RELAY_SESSION.idFromName(id)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Forward the COMPLETE original request
  return sessionStub.fetch(c.req.raw)
})

export { RelaySession }
export default app