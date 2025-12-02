import { DurableObject } from 'cloudflare:workers'

/**
 * @typedef {object} Env
 * @property {DurableObjectNamespace<RelaySession>} RELAY_SESSION
 */

export class RelaySession extends DurableObject {
  /** @type {DurableObjectState<Env>} */
  ctx

  /**
   * @param {DurableObjectState<Env>} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.sessionAlarmTime = 5 * 60 * 1000
    this.keepAliveInterval = 30 * 1000
    console.log(`[DO ${this.ctx.id}] Constructor called`)
  }

  async initialize(secretToken) {
    await this.ctx.storage.put('secretToken', secretToken)
    console.log(`[DO ${this.ctx.id}] initialize() called`)
    await this.ctx.storage.setAlarm(Date.now() + this.sessionAlarmTime)
    console.log(`[DO ${this.ctx.id}] Session expiry alarm set`)
  }

  /**
   *
   * @param {Request} request
   * @returns
   */
  async fetch(request) {
    // Handle POST initialization
    if (request.method === 'POST') {
      const { secretToken } = await request.json()
      await this.initialize(secretToken)
      return new Response('Initialization successful', { status: 200 })
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const [client, server] = Object.values(new WebSocketPair())

    // Get client type from URL path
    const url = new URL(request.url)
    const pathEnd = url.pathname.split('/').at(-1)

    let clientType = 'unknown'
    switch (pathEnd) {
      case "connect":
        clientType = 'pc'
        break
      case "join":
        const token = url.searchParams.get('token')
        const storedToken = await this.ctx.storage.get('secretToken')
        if (token !== storedToken) {
          server.close(1008, 'Invalid token')
          return new Response('Invalid token', { status: 403 })
        }
        clientType = 'tablet'
        // Tablet connected - cancel expiry alarm
        await this.ctx.storage.deleteAlarm()
        // Set keep-alive alarm
        await this.ctx.storage.setAlarm(Date.now() + this.keepAliveInterval)
        break
    }

    // In the fetch method, after acceptWebSocket:
    console.log(`[DO ${this.ctx.id}] Accepted WebSocket with tag: [${clientType}]`)
    this.ctx.acceptWebSocket(server, [clientType])

    // Verify the tag was set
    const taggedSockets = this.ctx.getWebSockets(clientType)
    console.log(`[DO ${this.ctx.id}] Now has ${taggedSockets.length} ${clientType} socket(s)`)

    // Send immediate welcome message
    server.send(JSON.stringify({
      type: 'system',
      message: 'Connection established',
      clientType
    }))

    // If tablet just connected, notify PC
    if (clientType === 'tablet') {
      const pcSockets = this.ctx.getWebSockets('pc')
      if (pcSockets.length > 0) {
        pcSockets[0].send(JSON.stringify({
          type: 'tablet_connected',
          timestamp: Date.now()
        }))
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  /**
   *
   * @param {WebSocket} ws
   * @param {String} tag
   */
  isSocketOfGivenTag(ws, tag) {
    return this.ctx
      .getWebSockets(tag)
      .some(socket => socket === ws)
  }

  /**
   *
   * @param {webSocket} ws
   * @returns
   */
  getWsTag(ws) {
    const tags = ['pc', 'tablet']
    for (const tag of tags) {
      if (this.isSocketOfGivenTag(ws, tag)) {
        return tag
      }
    }
    return 'unknown'
  }

  async webSocketMessage(ws, message) {
    // Determine clientType by checking which tag this WebSocket has
    let clientType = this.getWsTag(ws)

    console.log(`[DO ${this.ctx.id}] Message from ${clientType}: ${message}`)

    try {
      // Parse JSON message
      const data = JSON.parse(message)
      console.log(`[DO ${this.ctx.id}] JSON from ${clientType}:`, data)

      // Handle special commands
      if (data.type === 'close' && clientType === 'tablet') {
        console.log(`[DO ${this.ctx.id}] Tablet requested closure`)
        const allSockets = this.ctx.getWebSockets()
        allSockets.forEach(socket => {
          socket.close(1000, 'Closed by tablet')
        })
        return
      }

      // Relay to the other client using WebSocket tags
      const otherClientType = clientType === 'pc' ? 'tablet' : 'pc'
      const otherSockets = this.ctx.getWebSockets(otherClientType)

      if (otherSockets.length > 0) {
        // Send the original JSON data (not wrapped)
        otherSockets[0].send(JSON.stringify(data))
        console.log(`[DO ${this.ctx.id}] Relayed to ${otherClientType}`)
      } else {
        console.log(`[DO ${this.ctx.id}] No active ${otherClientType} to relay to`)
      }

    } catch (e) {
      console.error(`[DO ${this.ctx.id}] Invalid JSON from ${clientType}:`, message)
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Method 1: Check all active WebSocket tags to identify this one
    const clientType = this.getWsTag(ws)

    console.log(`[DO ${this.ctx.id}] ${clientType} disconnected: ${reason} (code: ${code})`)

    // If we successfully identified which client disconnected, close the other
    if (clientType !== 'unknown') {
      const otherClientType = clientType === 'pc' ? 'tablet' : 'pc'
      const otherSockets = this.ctx.getWebSockets(otherClientType)

      if (otherSockets.length > 0) {
        console.log(`[DO ${this.ctx.id}] Also closing ${otherClientType} because ${clientType} disconnected`)
        otherSockets[0].close(1000, `${clientType} disconnected`)
      }
    }

    // Debug: Log current socket counts
    const allSockets = this.ctx.getWebSockets()
    console.log(`[DO ${this.ctx.id}] Remaining sockets: ${allSockets.length} total`)
  }

  async alarm() {
    console.log(`[DO ${this.ctx.id}] Alarm triggered`)

    // Check if we have active WebSockets
    const allSockets = this.ctx.getWebSockets()

    if (allSockets.length > 0) {
      // We have active connections - set next keep-alive
      console.log(`[DO ${this.ctx.id}] Keep-alive: ${allSockets.length} active connections`)
      await this.ctx.storage.setAlarm(Date.now() + this.keepAliveInterval)
    } else {
      // No active connections - session expired
      console.log(`[DO ${this.ctx.id}] Session expired - cleaning up`)
      await this.ctx.storage.delete('secretToken')
    }
  }
}