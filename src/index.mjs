import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { getMimeType } from 'hono/utils/mime'
import HttpMethods from 'http-methods-constants'

import slugs from './constants/slugs.mjs'
import { RelaySession } from './relay-session.mjs'
import getNewToken from './token-generator.mjs'

const app = new Hono()
app.use(logger())

// 1. Endpoint for Plover (PC) to create a new session
app.post(`/${slugs.SESSION}/${slugs.INITIATE}`, async (c) => {
  const { RELAY_SESSION } = c.env

  const sessionId = crypto.randomUUID()

  // Use .map() which returns a new array, instead of .forEach() which returns undefined.
  const [tabletConnectionToken, pcConnectionToken] = Array.from({ length: 2 }, getNewToken)

  const sessionIdFromName = RELAY_SESSION.idFromName(sessionId)
  const sessionStub = RELAY_SESSION.get(sessionIdFromName)

  // Initialize the Durable Object
  const initRequest = new Request(c.req.url, {
    method: HttpMethods.POST,
    headers: { 'Content-Type': getMimeType('json') },
    body: JSON.stringify({ tabletConnectionToken, pcConnectionToken })
  })
  await sessionStub.fetch(initRequest)

  const workerUrl = new URL(c.req.url)

  return c.json({
    protocol: workerUrl.protocol.replace('http', 'ws'),
    sessionId,
    tabletConnectionToken,
    pcConnectionToken
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
