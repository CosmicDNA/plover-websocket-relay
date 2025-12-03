import { DurableObject } from 'cloudflare:workers'

import HttpMethods from '../node_modules/http-methods-constants/index'
import { ReasonPhrases } from '../node_modules/http-status-codes/build/cjs/reason-phrases'
import { StatusCodes } from '../node_modules/http-status-codes/build/cjs/status-codes'
import WsStatusCodes from '../node_modules/websocket-event-codes/index'
import searchParams from './constants/search-params.mjs'
import slugs from './constants/slugs.mjs'
import { deviceTags, knownDeviceTags, labels } from './constants/tags.mjs'
import SingletonViolation from './errors/singleton-violation.mjs'

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
    console.debug(`[DO ${this.ctx.id}] Constructor called`)
  }

  async initialize(secretToken) {
    await this.ctx.storage.put(labels.SECRET_TOKEN, secretToken)
    console.debug(`[DO ${this.ctx.id}] initialize() called`)
    await this.ctx.storage.setAlarm(Date.now() + this.sessionAlarmTime)
    console.debug(`[DO ${this.ctx.id}] Session expiry alarm set`)
  }

  /**
   *
   * @param {String} deviceType
   * @returns
   */
  enforceSingleton(deviceType) {
    // Enforce singleton PC connection
    if (this.ctx.getWebSockets(deviceType).length > 0) {
      const message = `A ${deviceType} is already connected to this session.`
      console.warn(`[DO ${this.ctx.id}] Rejected second ${deviceType} connection.`)
      throw new SingletonViolation(message)
    }
  }

  /**
   *
   * @param {Request} request
   * @returns
   */
  async fetch(request) {
    // Ensure the client ID counter is initialized before use.
    await this.getNextClientId()

    // Handle POST initialization
    if (request.method === HttpMethods.POST) {
      const { secretToken } = await request.json()
      await this.initialize(secretToken)
      return new Response(labels.INITIALIZATION_SUCCESSFUL, { status: StatusCodes.OK })
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(labels.EXPECTED_WEBSOCKET, { status: StatusCodes.UPGRADE_REQUIRED })
    }

    const [client, server] = Object.values(new WebSocketPair())

    // Get client type from URL path
    const url = new URL(request.url)
    const pathEnd = url.pathname.split('/').at(-1)

    let clientType
    try {
      switch (pathEnd) {
        case slugs.CONNECT:
          clientType = deviceTags.PC
          this.enforceSingleton(clientType)
          break
        case slugs.JOIN:
          const token = url.searchParams.get(searchParams.TOKEN)
          const storedToken = await this.ctx.storage.get(labels.SECRET_TOKEN)
          if (token !== storedToken) {
            server.close(WsStatusCodes.POLICY_VIOLATION, labels.INVALID_TOKEN)
            return new Response(labels.INVALID_TOKEN, { status: StatusCodes.FORBIDDEN })
          }
          clientType = deviceTags.TABLET
          // Tablet connected - cancel expiry alarm
          await this.ctx.storage.deleteAlarm()
          // Set keep-alive alarm
          await this.ctx.storage.setAlarm(Date.now() + this.keepAliveInterval)
          break
        default:
          clientType = deviceTags.UNKNOWN
          break
      }

      // Assign a unique ID to the client for private messaging
      const clientId = this.nextClientId++
      await this.ctx.storage.put('nextClientId', this.nextClientId)

      // In the fetch method, after acceptWebSocket:
      console.debug(`[DO ${this.ctx.id}] Accepted WebSocket with tag: [${clientType}] (id: ${clientId})`)
      this.ctx.acceptWebSocket(server, [clientType, `id:${clientId}`])

      // Verify the tag was set
      const taggedSockets = this.ctx.getWebSockets(clientType)
      console.debug(`[DO ${this.ctx.id}] Now has ${taggedSockets.length} ${clientType} socket(s)`)

      // Send immediate welcome message
      // This message includes the client's newly assigned ID
      server.send(JSON.stringify({
        id: clientId,
        type: labels.SYSTEM,
        message: labels.CONNECTION_ESTABLISHED,
        clientType
      }))

      // If tablet just connected, notify PC
      if (clientType === deviceTags.TABLET) {
        this.callToComplementary(clientType,
          (socket, otherClientType) => {
            socket.send(JSON.stringify({
              type: labels.TABLET_CONNECTED,
              timestamp: Date.now(),
              id: clientId // Let the PC know the ID of the new tablet
            }))
          }
        )
      }

      return new Response(null, { // Body should be null for WebSocket upgrade
        status: StatusCodes.SWITCHING_PROTOCOLS,
        webSocket: client
      })
    } catch (e) {
      if (e instanceof SingletonViolation) {
        server.close(WsStatusCodes.POLICY_VIOLATION, e.message)
        return new Response(e.message, { status: StatusCodes.CONFLICT })
      } else {
        console.error(`[DO ${this.ctx.id}] Unexpected error in fetch:`, e)
        return new Response(ReasonPhrases.INTERNAL_SERVER_ERROR, { status: StatusCodes.INTERNAL_SERVER_ERROR })
      }
    }
  }

  /**
   * Extracts the client type and ID from a WebSocket's tags.
   * @param {WebSocket} ws The WebSocket instance.
   * @returns {{id: number | null, type: string}}
   */
  getClientInfo(ws) {
    const tags = this.ctx.getTags(ws)
    const type = tags.find(tag => tag === deviceTags.PC || tag === deviceTags.TABLET) || deviceTags.UNKNOWN
    const idTag = tags.find(tag => tag.startsWith('id:'))
    const id = idTag ? parseInt(idTag.split(':')[1], 10) : null
    return { id, type }
  }

  /**
   *
   * @param {String} clientType
   * @returns
   */
  getComplementaryDevice(clientType) {
    return clientType === deviceTags.PC ? deviceTags.TABLET : deviceTags.PC
  }

  /**
   * @callback ComplementarySocketCallback
   * @param {WebSocket} socket The complementary WebSocket instance.
   * @param {string} otherClientType The type of the complementary client.
   */

  /**
   * @callback EmptyComplementaryCallback
   * @param {string} otherClientType The type of the complementary client that was not found.
   */

  /**
   * Executes a callback for each WebSocket of the complementary device type.
   * If no complementary devices are connected, an optional empty-state callback is executed.
   * @param {string} clientType The type of the client initiating the action (e.g., 'pc' or 'tablet').
   * @param {ComplementarySocketCallback} callback The function to execute for each complementary socket.
   * @param {EmptyComplementaryCallback} [emptyCallback=() => {}] The function to execute if no complementary sockets are found.
   */
  callToComplementary(clientType, callback, emptyCallback = () => { }) {
    const otherClientType = this.getComplementaryDevice(clientType)
    const otherSockets = this.ctx.getWebSockets(otherClientType)

    for (const otherSocket of otherSockets) {
      callback(otherSocket, otherClientType)
    }

    if (otherSockets.length === 0) {
      emptyCallback(otherClientType)
    }
  }

  /**
   *
   * @param {WebSocket} ws
   * @param {string | ArrayBuffer} message
   * @returns
   */
  async webSocketMessage(ws, message) {
    // Determine clientType by checking which tag this WebSocket has
    const sender = this.getClientInfo(ws)

    console.debug(`[DO ${this.ctx.id}] Message from ${sender.type} (id: ${sender.id}): ${message}`)

    try {
      // Parse JSON message
      const data = JSON.parse(message)
      console.debug(`[DO ${this.ctx.id}] JSON from ${sender.type} (id: ${sender.id}):`, data)

      // Handle keep-alive pings
      if (data.type === 'ping') {
        console.debug(`[DO ${this.ctx.id}] Received ping from ${sender.type} (id: ${sender.id}).`)
        // Respond with a pong to let the client know the connection is active.
        ws.send(JSON.stringify({ type: 'pong' }))
        console.debug(`[DO ${this.ctx.id}] Sent pong to ${sender.type} (id: ${sender.id}).`)
        return
      }

      // New message routing logic
      const payload = data.payload

      // Handle special commands within the payload
      if (payload?.command === 'close') {
        console.debug(`[DO ${this.ctx.id}] ${sender.type} (id: ${sender.id}) requested closure. Closing all connections.`)
        // Get all sockets currently in the session and close them to terminate the session.
        const allSockets = this.ctx.getWebSockets()
        const closeReason = `${labels.SESSION_CLOSED_BY_CLIENT_PREFIX} ${sender.type} (id: ${sender.id})`
        for (const socket of allSockets) {
          socket.close(WsStatusCodes.NORMAL_CLOSURE, closeReason)
        }
        return
      }

      const recipient = data.to
      if (!recipient || !payload) {
        console.warn(`[DO ${this.ctx.id}] Invalid message format from ${sender.type} (id: ${sender.id}). Missing 'to' or 'payload'.`)
        return
      }

      // Add sender information to the payload
      const messageToSend = JSON.stringify({ ...payload, from: sender })

      // Private message: 'to.id' is specified
      if (recipient.id !== undefined) {
        // Find the target socket by its ID tag
        const targetSockets = this.ctx.getWebSockets(`id:${recipient.id}`)
        if (targetSockets.length > 0) {
          const targetSocket = targetSockets[0]
          const targetInfo = this.getClientInfo(targetSocket)
          targetSocket.send(messageToSend)
          console.debug(`[DO ${this.ctx.id}] Relayed private message from ${sender.type} (id: ${sender.id}) to ${targetInfo.type} (id: ${targetInfo.id})`)
          return // Message sent, we are done
        }
        console.warn(`[DO ${this.ctx.id}] Could not find recipient: ${recipient.type} (id: ${recipient.id})`)
      } else { // Public message to a client type
        const targetSockets = this.ctx.getWebSockets(recipient.type)
        // Ensure the sender is not included in the public relay if they are also of the recipient type
        const senderSocket = ws
        if (targetSockets.length > 0) {
          let sentCount = 0
          for (const socket of targetSockets) {
            // Don't send the message back to the sender
            if (socket !== senderSocket) {
              socket.send(messageToSend)
              sentCount++
            }
          }
          console.debug(`[DO ${this.ctx.id}] Relayed public message from ${sender.type} (id: ${sender.id}) to ${sentCount} ${recipient.type}(s)`)
        }
      }
    } catch (e) {
      console.error(`[DO ${this.ctx.id}] Invalid JSON from ${sender.type} (id: ${sender.id}):`, message)
    }
  }

  /**
   * Handles WebSocket close events.
   *
   * @param {WebSocket} ws The WebSocket that was closed.
   * @param {number} code The status code indicating the reason for closure.
   * @param {string} reason A human-readable string explaining the reason for closure.
   * @param {boolean} wasClean A boolean indicating whether the connection was closed cleanly.
   */
  async webSocketClose(ws, code, reason, wasClean) {
    // Method 1: Check all active WebSocket tags to identify this one
    const clientInfo = this.getClientInfo(ws)
    console.debug(`[DO ${this.ctx.id}] ${clientInfo.type} (id: ${clientInfo.id}) disconnected: ${reason} (code: ${code})`)

    // If a graceful shutdown was initiated by a tablet, do nothing further.
    if (!reason.startsWith(labels.SESSION_CLOSED_BY_CLIENT_PREFIX)) {
      switch (clientInfo.type) {
        case deviceTags.PC:
          // PC disconnected unexpectedly, close all complementary (tablet) sockets.
          this.callToComplementary(clientInfo.type, (socket, otherClientType) => {
            console.debug(`[DO ${this.ctx.id}] Also closing this ${otherClientType} because ${clientInfo.type} (id: ${clientInfo.id}) disconnected`)
            socket.close(WsStatusCodes.NORMAL_CLOSURE, `${clientInfo.type} (id: ${clientInfo.id}) disconnected`)
          })
          break
        case deviceTags.TABLET:
          // A tablet disconnected. If it was the last one, close the PC socket.
          if (this.ctx.getWebSockets(deviceTags.TABLET).length === 0) {
            const reason = `${labels.LAST_TABLET_DISCONNECTED} (was id: ${clientInfo.id})`
            console.debug(`[DO ${this.ctx.id}] ${reason}`)
            this.callToComplementary(clientInfo.type, (socket) => socket.close(WsStatusCodes.NORMAL_CLOSURE, reason))
          }
          break
      }
    }

    // Debug: Log current socket counts
    const allSockets = this.ctx.getWebSockets()
    console.debug(`[DO ${this.ctx.id}] Remaining sockets: ${allSockets.length} total`)
  }

  /**
   * Fetches the next client ID from storage, or initializes it.
   */
  async getNextClientId() {
    this.nextClientId = (await this.ctx.storage.get('nextClientId')) || 0
  }

  async alarm() {
    console.debug(`[DO ${this.ctx.id}] Alarm triggered`)

    // Check if we have active WebSockets
    const allSockets = this.ctx.getWebSockets()

    if (allSockets.length > 0) {
      // We have active connections - set next keep-alive
      console.debug(`[DO ${this.ctx.id}] Keep-alive: ${allSockets.length} active connections`)
      await this.ctx.storage.setAlarm(Date.now() + this.keepAliveInterval)
    } else {
      // No active connections - session expired
      console.debug(`[DO ${this.ctx.id}] Session expired - cleaning up`)
      await this.ctx.storage.delete(labels.SECRET_TOKEN)
    }
  }
}