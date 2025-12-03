import { DurableObject } from 'cloudflare:workers'

import HttpMethods from '../node_modules/http-methods-constants/index'
import { StatusCodes } from '../node_modules/http-status-codes/build/cjs/status-codes'
import WsStatusCodes from '../node_modules/websocket-event-codes/index'
import searchParams from './constants/search-params.mjs'
import slugs from './constants/slugs.mjs'
import { deviceTags, knownDeviceTags, labels } from './constants/tags.mjs'

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
   * @param {Request} request
   * @returns
   */
  async fetch(request) {
    // Handle POST initialization
    if (request.method === HttpMethods.POST) {
      const { secretToken } = await request.json()
      await this.initialize(secretToken)
      return new Response('Initialization successful', { status: StatusCodes.OK })
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: StatusCodes.UPGRADE_REQUIRED })
    }

    const [client, server] = Object.values(new WebSocketPair())

    // Get client type from URL path
    const url = new URL(request.url)
    const pathEnd = url.pathname.split('/').at(-1)

    let clientType
    switch (pathEnd) {
      case slugs.CONNECT:
        clientType = deviceTags.PC
        break
      case slugs.JOIN:
        const token = url.searchParams.get(searchParams.TOKEN)
        const storedToken = await this.ctx.storage.get(labels.SECRET_TOKEN)
        if (token !== storedToken) {
          const message = 'Invalid token'
          server.close(WsStatusCodes.POLICY_VIOLATION, message)
          return new Response(message, { status: StatusCodes.FORBIDDEN })
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

    // In the fetch method, after acceptWebSocket:
    console.debug(`[DO ${this.ctx.id}] Accepted WebSocket with tag: [${clientType}]`)
    this.ctx.acceptWebSocket(server, [clientType])

    // Verify the tag was set
    const taggedSockets = this.ctx.getWebSockets(clientType)
    console.debug(`[DO ${this.ctx.id}] Now has ${taggedSockets.length} ${clientType} socket(s)`)

    // Send immediate welcome message
    server.send(JSON.stringify({
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
            timestamp: Date.now()
          }))
        }
      )
    }

    return new Response(null, {
      status: StatusCodes.SWITCHING_PROTOCOLS,
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
    for (const tag of Object.values(knownDeviceTags)) {
      if (this.isSocketOfGivenTag(ws, tag)) {
        return tag
      }
    }
    return deviceTags.UNKNOWN
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
  callToComplementary(clientType, callback, emptyCallback = () => {}) {
    const otherClientType = this.getComplementaryDevice(clientType)
    const otherSockets = this.ctx.getWebSockets(otherClientType)

    for (const otherSocket of otherSockets) {
      callback(otherSocket, otherClientType)
    }

    if (otherSockets.length === 0) {
      emptyCallback(otherClientType)
    }
  }

  async webSocketMessage(ws, message) {
    // Determine clientType by checking which tag this WebSocket has
    let clientType = this.getWsTag(ws)

    console.debug(`[DO ${this.ctx.id}] Message from ${clientType}: ${message}`)

    try {
      // Parse JSON message
      const data = JSON.parse(message)
      console.debug(`[DO ${this.ctx.id}] JSON from ${clientType}:`, data)

      // Handle special commands
      if (data.type === 'close' && clientType === deviceTags.TABLET) {
        console.debug(`[DO ${this.ctx.id}] Tablet requested closure`)
        const allSockets = this.ctx.getWebSockets()
        allSockets.forEach(socket => {
          socket.close(WsStatusCodes.NORMAL_CLOSURE, labels.CLOSED_BY_TABLET)
        })
        return
      }

      this.callToComplementary(clientType,
        (socket, otherClientType) => {
          socket.send(JSON.stringify(data))
          console.debug(`[DO ${this.ctx.id}] Relayed to this ${otherClientType}`)
        },
        otherClientType => {
          console.debug(`[DO ${this.ctx.id}] No active ${otherClientType} to relay to`)
        }
      )

    } catch (e) {
      console.error(`Invalid JSON from ${clientType}:`, message)
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
    const clientType = this.getWsTag(ws)

    console.debug(`[DO ${this.ctx.id}] ${clientType} disconnected: ${reason} (code: ${code})`)

    // If we successfully identified which client disconnected, close the other
    if (clientType !== deviceTags.UNKNOWN) {
      this.callToComplementary(clientType, (socket, otherClientType) => {
        console.debug(`[DO ${this.ctx.id}] Also closing this ${otherClientType} because ${clientType} disconnected`)
        socket.close(WsStatusCodes.NORMAL_CLOSURE, `${clientType} disconnected`)
      })
    }

    // Debug: Log current socket counts
    const allSockets = this.ctx.getWebSockets()
    console.debug(`[DO ${this.ctx.id}] Remaining sockets: ${allSockets.length} total`)
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