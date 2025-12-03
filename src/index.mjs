import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { getMimeType } from 'hono/utils/mime'

import HttpMethods from '../node_modules/http-methods-constants/index'
import protocols from './constants/protocols.mjs'
import searchParams from './constants/search-params.mjs'
import slugs from './constants/slugs.mjs'
import { RelaySession } from './relay-session.mjs'

const app = new Hono()
app.use(logger())

// 1. Endpoint for Plover (PC) to create a new session
app.post(`/${slugs.SESSION}/${slugs.INITIATE}`, async (c) => {
  const { RELAY_SESSION } = c.env

  const sessionId = crypto.randomUUID()
  const secretToken = [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0')).join('')

  const sessionIdFromName = RELAY_SESSION.idFromName(sessionId)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Initialize the Durable Object
  await sessionStub.fetch(new Request(c.req.url, {
    method: HttpMethods.POST,
    headers: { 'Content-Type': getMimeType('json') },
    body: JSON.stringify({ secretToken })
  }))

  const workerUrl = new URL(c.req.url)
  // Use 'ws' for localhost (local dev) and 'wss' for all other environments.
  const protocol = workerUrl.hostname === 'localhost' ? protocols.WS : protocols.WSS
  const wsBaseUrl = `${protocol}://${workerUrl.host}` // Use .host to include the port automatically
  const tabletConnectionUrl = `${wsBaseUrl}/${slugs.SESSION}/${sessionId}/${slugs.JOIN}?${searchParams.TOKEN}=${secretToken}` // e.g., ws://localhost:8787/...

  return c.json({
    sessionId,
    tabletConnectionUrl
  })
})

// 2. WebSocket endpoint for the Tablet to JOIN
app.get(`/${slugs.SESSION}/${slugs.COLON_ID}/${slugs.JOIN}`, async (c) => {
  // IMPORTANT: Just forward the raw request - NO upgrade check here!
  const { id } = c.req.param()
  const { RELAY_SESSION } = c.env
  const sessionIdFromName = RELAY_SESSION.idFromName(id)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Forward the COMPLETE original request
  return sessionStub.fetch(c.req.raw)
})

// 3. WebSocket endpoint for the PC to CONNECT
app.get(`/${slugs.SESSION}/${slugs.COLON_ID}/${slugs.CONNECT}`, async (c) => {
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