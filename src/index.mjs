import { Hono } from 'hono'
import { RelaySession } from './relay-session.mjs'

const app = new Hono()

// 1. Endpoint for Plover (PC) to create a new session
app.post('/session/initiate', async (c) => {
  const { RELAY_SESSION } = c.env

  // Generate unique IDs for this session
  const sessionId = crypto.randomUUID()
  const secretToken = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0')).join('')

  // Create a new Durable Object for this session
  const sessionIdFromName = RELAY_SESSION.idFromName(sessionId)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Initialize the session with the secret token
  await sessionStub.initialize(secretToken)

  const workerUrl = new URL(c.req.url);
  // Replace 'http' with 'ws' and ensure it's the worker's hostname
  const wssBaseUrl = `wss://${workerUrl.hostname}`;
  const tabletConnectionUrl = `${wssBaseUrl}/session/${sessionId}/join?token=${secretToken}`;

  // Return the info the PC plugin needs
  return c.json({
    sessionId,
    // The URL for the tablet to connect (will be encoded in QR code)
    tabletConnectionUrl
  })
})

// 2. WebSocket endpoint for the Tablet to JOIN
app.get('/session/:id/join', async (c) => {
  const { id } = c.req.param()
  const token = c.req.query('token') // Get token from QR code URL

  const { RELAY_SESSION } = c.env
  const sessionIdFromName = RELAY_SESSION.idFromName(id)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Forward the request to the Durable Object.
  // The Durable Object will handle WebSocket upgrade and token validation.
  return sessionStub.fetch(c.req.raw, { clientType: 'tablet', token })
})

// 3. WebSocket endpoint for the PC to CONNECT (after creating session)
app.get('/session/:id/connect', async (c) => {
  const { id } = c.req.param()
  const { RELAY_SESSION } = c.env
  const sessionIdFromName = RELAY_SESSION.idFromName(id)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Forward to Durable Object as a PC connection
  return sessionStub.fetch(c.req.raw, { clientType: 'pc' })
})

export { RelaySession }
export default app
