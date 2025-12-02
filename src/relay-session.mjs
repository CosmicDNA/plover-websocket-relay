import { DurableObject } from 'cloudflare:workers'

export class RelaySession extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.pcSocket = null
    this.tabletSocket = null
    this.secretToken = null
    this.sessionAlarmTime = 5 * 60 * 1000
    this.keepAliveInterval = 30 * 1000
    console.log(`[DO ${this.ctx.id}] Constructor called`)
  }

  async initialize(secretToken) {
    this.secretToken = secretToken
    await this.ctx.storage.put('secretToken', secretToken)
    console.log(`[DO ${this.ctx.id}] initialize() called`)
    await this.ctx.storage.setAlarm(Date.now() + this.sessionAlarmTime)
    console.log(`[DO ${this.ctx.id}] Session expiry alarm set`)
  }

  async fetch(request) {
    // Handle POST initialization
    if (request.method === 'POST') {
      const { secretToken } = await request.json()
      await this.initialize(secretToken)
      return new Response('Initialization successful', { status: 200 })
    }

    // Get client type from URL path
    const url = new URL(request.url)
    const path = url.pathname
    let clientType = 'unknown'
    let token = null

    if (path.endsWith('/connect')) {
      clientType = 'pc'
    } else if (path.endsWith('/join')) {
      clientType = 'tablet'
      token = url.searchParams.get('token')
    }

    console.log(`[DO ${this.ctx.id}] WebSocket upgrade for ${clientType}`)

    // WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const [client, server] = Object.values(new WebSocketPair())

    // Load secret token for validation
    const storedToken = await this.ctx.storage.get('secretToken')

    // Tablet token validation
    if (clientType === 'tablet') {
      if (token !== storedToken) {
        server.close(1008, 'Invalid token')
        return new Response('Invalid token', { status: 403 })
      }
      // Tablet connected - cancel expiry alarm
      await this.ctx.storage.deleteAlarm()
    }

    // Store clientType in a Map that persists across this instance
    // This is the key fix - we store the WebSocket reference immediately
    if (clientType === 'pc') {
      this.pcSocket = server
    } else if (clientType === 'tablet') {
      this.tabletSocket = server
    }

    // Store the clientType in the Durable Object's state for this session
    // This will help if the object hibernates
    await this.ctx.storage.put(`active_${clientType}`, true)

    // Accept WebSocket WITH clientType in attachment (for immediate use)
    this.ctx.acceptWebSocket(server, [clientType])

    // Send immediate welcome message
    server.send(JSON.stringify({
      type: 'system',
      message: 'Connection established',
      clientType
    }))

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  async webSocketMessage(ws, message) {
    // Method 1: Check if this WebSocket matches our stored references
    let clientType = 'unknown'

    if (ws === this.pcSocket) {
      clientType = 'pc'
    } else if (ws === this.tabletSocket) {
      clientType = 'tablet'
    } else {
      // Method 2: Try to get from attachment (might work on first message)
      const attachment = ws.deserializeAttachment()
      if (attachment && attachment[0]) {
        clientType = attachment[0]
        // Update our references
        if (clientType === 'pc') {
          this.pcSocket = ws
        } else if (clientType === 'tablet') {
          this.tabletSocket = ws
        }
      } else {
        // Method 3: Check storage to see which client is active
        const isPcActive = await this.ctx.storage.get('active_pc')
        const isTabletActive = await this.ctx.storage.get('active_tablet')

        // Determine based on active connections (PC connects first)
        if (isPcActive && !this.pcSocket) {
          clientType = 'pc'
          this.pcSocket = ws
        } else if (isTabletActive && !this.tabletSocket) {
          clientType = 'tablet'
          this.tabletSocket = ws
        }
      }
    }

    console.log(`[DO ${this.ctx.id}] Message from ${clientType}: ${message}`)

    // Handle test messages with correct clientType
    if (message === 'Hi' || message === 'Bye') {
      ws.send(JSON.stringify({
        type: 'echo',
        from: clientType,  // Now shows 'pc' or 'tablet'
        message: `Got: ${message}`
      }))
      return
    }

    // For real JSON messages, you'd parse and relay here
    try {
      const data = JSON.parse(message)
      console.log(`[DO ${this.ctx.id}] JSON from ${clientType}:`, data)

      // Relay to the other client
      const target = clientType === 'pc' ? this.tabletSocket : this.pcSocket
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({
          ...data,
          relayedFrom: clientType,
          timestamp: Date.now()
        }))
      }
    } catch (e) {
      console.error(`[DO ${this.ctx.id}] Invalid JSON:`, message)
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Determine which client disconnected
    let clientType = 'unknown'
    if (ws === this.pcSocket) {
      clientType = 'pc'
      this.pcSocket = null
      await this.ctx.storage.delete('active_pc')
    } else if (ws === this.tabletSocket) {
      clientType = 'tablet'
      this.tabletSocket = null
      await this.ctx.storage.delete('active_tablet')
    }

    console.log(`[DO ${this.ctx.id}] ${clientType} disconnected: ${reason}`)
  }

  async alarm() {
    console.log(`[DO ${this.ctx.id}] Session expired - closing`)
    // Clean up storage
    await this.ctx.storage.delete('active_pc')
    await this.ctx.storage.delete('active_tablet')
    await this.ctx.storage.delete('secretToken')
  }
}