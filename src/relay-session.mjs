import { DurableObject } from 'cloudflare:workers'

export class RelaySession extends DurableObject {
  constructor (ctx, env) {
    super(ctx, env)
    // State managed by this instance
    this.ctx = ctx
    this.pcSocket = null
    this.tabletSocket = null
    this.secretToken = null
    this.sessionAlarmTime = 5 * 60 * 1000 // 5 minutes
  }

  // Called by the Worker when a new session is created
  async initialize (secretToken) {
    this.secretToken = secretToken
    // Set an alarm to clean up if no tablet joins
    this.ctx.storage.setAlarm(Date.now() + this.sessionAlarmTime)
  }

  // Main handler for all HTTP/WebSocket requests to this Durable Object
  async fetch (request, options = {}) {
    // const url = new URL(request.url) // 'url' is assigned a value but never used.
    const upgradeHeader = request.headers.get('Upgrade')

    // --- Handle WebSocket Upgrade ---
    if (upgradeHeader === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair())

      // Get client type and token passed from the main Worker
      const clientType = options.clientType // 'pc' or 'tablet'
      const token = options.token

      // --- CRITICAL SECURITY CHECK for Tablet ---
      if (clientType === 'tablet' && token !== this.secretToken) {
        server.close(1008, 'Invalid or expired token')
        return new Response(null, { status: 403 })
      }

      // Accept WebSocket WITH HIBERNATION API (for cost control)
      this.ctx.acceptWebSocket(server)

      // Store reference to the WebSocket
      if (clientType === 'pc') {
        this.pcSocket = server
        console.log('PC connected to session')
      } else if (clientType === 'tablet') {
        this.tabletSocket = server
        console.log('Tablet connected to session')
        // Cancel the expiry alarm since tablet joined
        this.ctx.storage.deleteAlarm()
        // Notify PC
        this.sendToPc({ type: 'tablet_connected' })
      }

      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('Expected WebSocket upgrade', { status: 426 })
  }

  // --- WebSocket Message Handler (called by runtime) ---
  async webSocketMessage (ws, message) {
    // Parse incoming message (expecting JSON)
    let data
    try {
      data = JSON.parse(message)
    } catch (e) {
      console.error('Invalid JSON received:', message)
      return
    }

    // Determine sender and target
    const sender = (ws === this.pcSocket) ? 'pc' : 'tablet'
    const target = (sender === 'pc') ? this.tabletSocket : this.pcSocket

    // --- Handle Special Commands ---
    if (data.type === 'close' && sender === 'tablet') {
      // Tablet requested closure (e.g., via QR code button)
      this.closeSession('Closed by tablet')
      return
    }

    // --- Relay All Other Messages ---
    if (target && target.readyState === WebSocket.READY_STATE_OPEN) {
      target.send(JSON.stringify(data))
    }
  }

  // --- Helper Methods ---
  sendToPc (data) {
    if (this.pcSocket?.readyState === WebSocket.READY_STATE_OPEN) {
      this.pcSocket.send(JSON.stringify(data))
    }
  }

  closeSession (reason) {
    const code = 1000 // Normal closure
    if (this.pcSocket) this.pcSocket.close(code, reason)
    if (this.tabletSocket) this.tabletSocket.close(code, reason)
    // This Durable Object will be garbage collected
  }

  // Called when the session alarm triggers (e.g., no tablet joined)
  async alarm () {
    this.closeSession('Session expired (no tablet joined)')
  }
}
