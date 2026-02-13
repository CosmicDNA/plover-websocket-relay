import { DurableObject } from 'cloudflare:workers'
import HttpMethods from 'http-methods-constants'
import { ReasonPhrases, StatusCodes } from 'http-status-codes'
import WsStatusCodes from 'websocket-event-codes'

import searchParamsConstants from './constants/search-params.mjs'
import slugs from './constants/slugs.mjs'
import { deviceTags, labels, websocketTags } from './constants/tags.mjs'
import SingletonViolation from './errors/singleton-violation.mjs'
import TokenError from './errors/token-error.mjs'
import getNewToken from './token-generator.mjs'

/**
 * @typedef WebSocketPair
 * @type {{0: WebSocket, 1: WebSocket}}
 */

/**
 * Creates and returns a new WebSocketPair.
 * This is a utility function to encapsulate the global WebSocketPair constructor.
 * @returns {WebSocketPair} A new WebSocketPair instance, containing client and server WebSocket ends.
 */
const getWebSocketPair = () => {
  return new globalThis.WebSocketPair()
}

/**
 * @typedef {object} Env
 * @property {DurableObjectNamespace<RelaySession>} RELAY_SESSION
 */

export class RelaySession extends DurableObject {
  sessionAlarmTime = 5 * 60 * 1000
  keepAliveInterval = 30 * 1000

  /** @type {DurableObjectState<Env>} */
  ctx
  newTabletToken

  /** @type {string} */
  shortId
  /**
   * Creates an instance of the RelaySession Durable Object.
   * @param {DurableObjectState<Env>} ctx
   * @param {Env} env
   */
  constructor (ctx, env) {
    super(ctx, env)
    this.ctx = ctx
    this.shortId = String(ctx.id).slice(-5)
    console.debug(`[DO ${this.shortId}] Constructor called`)
  }

  /**
   * Initializes the session by storing the secret token and setting the initial expiry alarm.
   * This is called once when the session is first created.
   * @param {string} tabletConnectionToken The secret token for authenticating the tablet.
   * @param {string} pcConnectionToken The secret token for authenticating the PC.
   */
  async initialize (tabletConnectionToken, pcConnectionToken) {
    await this.ctx.storage.put(labels.TABLET_CONNECTION_TOKEN, tabletConnectionToken)
    await this.ctx.storage.put(labels.PC_CONNECTION_TOKEN, pcConnectionToken)
    console.debug(`[DO ${this.shortId}] initialize() called, tokens stored`)
    await this.ctx.storage.setAlarm(Date.now() + this.sessionAlarmTime)
    console.debug(`[DO ${this.shortId}] Session expiry alarm set`)
  }

  /**
   * Enforces that only one client of a given type can be connected to the session.
   * Throws a SingletonViolation if a client of the same type already exists.
   * @param {string} deviceType The type of device to check (e.g., 'pc').
   */
  enforceSingleton (deviceType) {
    // Enforce singleton PC connection
    if (this.ctx.getWebSockets(`type:${deviceType}`).length > 0) {
      const message = `A ${deviceType} is already connected to this session.`
      console.warn(`[DO ${this.shortId}] Rejected second ${deviceType} connection.`)
      throw new SingletonViolation(message)
    }
  }

  /**
   * The main entry point for all requests to the Durable Object.
   * It handles session initialization via POST and WebSocket upgrade requests via GET.
   * @param {Request} request The incoming HTTP request.
   * @returns {Promise<Response>}
   */
  async fetch (request) {
    let clientType
    let clientId

    /**
     * @type {WebSocket}
     */
    let client
    /**
     * @type {WebSocket}
     */
    let server
    try {
      // Ensure the client ID counter is initialized before use.
      await this.getNextTabletId()

      // Handle POST initialization
      if (request.method === HttpMethods.POST) {
        const { tabletConnectionToken, pcConnectionToken } = await request.json()
        await this.initialize(tabletConnectionToken, pcConnectionToken)
        return new Response(labels.INITIALIZATION_SUCCESSFUL, { status: StatusCodes.OK })
      }

      // WebSocket upgrade
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response(labels.EXPECTED_WEBSOCKET, { status: StatusCodes.UPGRADE_REQUIRED })
      }

      ;[client, server] = Object.values(getWebSocketPair())

      // Get client type from URL path
      const url = new URL(request.url)
      const { searchParams, pathname } = url
      const pathEnd = pathname.split('/').at(-1)

      let publicKey = request.headers.get('X-Public-Key')
      if (!publicKey) {
        publicKey = searchParams.get('publicKey')
      }
      console.debug(`[DO ${this.shortId}] Client public key: ${publicKey}`)

      const connect = async () => {
        clientType = deviceTags.PC
        const pcToken = searchParams.get(searchParamsConstants.TOKEN)

        this.enforceSingleton(clientType)

        const storedPcToken = await this.ctx.storage.get(labels.PC_CONNECTION_TOKEN)
        if (pcToken !== storedPcToken) {
          throw new TokenError(labels.INVALID_TOKEN)
        }
        clientId = 0 // PC is always ID 0
      }

      const join = async () => {
        const token = searchParams.get(searchParamsConstants.TOKEN)
        const storedToken = await this.ctx.storage.get(labels.TABLET_CONNECTION_TOKEN)
        if (token !== storedToken) {
          throw new TokenError(labels.INVALID_TOKEN)
        }
        clientType = deviceTags.TABLET
        // Tablet connected - cancel expiry alarm
        await this.ctx.storage.deleteAlarm()
        // Set keep-alive alarm
        await this.ctx.storage.setAlarm(Date.now() + this.keepAliveInterval)

        clientId = this.nextTabletId++
        await this.ctx.storage.put(labels.TABLET_ID_COUNTER, this.nextTabletId)

        this.newTabletToken = getNewToken()
        await this.ctx.storage.put(labels.TABLET_CONNECTION_TOKEN, this.newTabletToken)
        this.iterateOverSockets(pcSocket => {
          pcSocket.send(JSON.stringify({
            clientType,
            id: clientId, // Let the PC know the ID of the new tablet
            type: labels.TABLET_CONNECTED,
            newTabletToken: this.newTabletToken,
            publicKey,
            timestamp: Date.now()
          }))
        }, labels.PC_TYPE)
      }

      switch (pathEnd) {
        case slugs.CONNECT:
          await connect()
          break
        case slugs.JOIN:
          await join()
          break
        default:
          clientType = deviceTags.UNKNOWN
          clientId = null
          break
      }

      console.debug(`[DO ${this.shortId}] Accepted WebSocket with tag: [${clientType}] (id: ${clientId})`)
      const tags = [`${websocketTags.TYPE}:${clientType}`, `${websocketTags.ID}:${clientId}`]
      this.ctx.acceptWebSocket(server, tags)

      const taggedSockets = this.ctx.getWebSockets(`${websocketTags.TYPE}:${clientType}`)
      console.debug(`[DO ${this.shortId}] Now has ${taggedSockets.length} ${clientType} socket(s)`)

      const welcomeMessage = {
        clientType,
        id: clientId,
        type: labels.SYSTEM,
        // publicKey,
        message: labels.CONNECTION_ESTABLISHED,
        newTabletToken: this.newTabletToken
      }
      server.send(JSON.stringify(welcomeMessage))

      return new Response(null, {
        status: StatusCodes.SWITCHING_PROTOCOLS,
        webSocket: client
      })
    } catch (e) {
      // Ensure the server-side socket is closed on error if it was created.
      if (e instanceof SingletonViolation) {
        return new Response(e.message, { status: StatusCodes.CONFLICT })
      } else if (e instanceof TokenError) {
        return new Response(e.message, { status: StatusCodes.FORBIDDEN })
      } else {
        console.error(`[DO ${this.shortId}] Uncaught exception:`, e)
        return new Response(ReasonPhrases.INTERNAL_SERVER_ERROR, { status: StatusCodes.INTERNAL_SERVER_ERROR })
      }
    }
  }

  /**
   * @template T
   * @callback IterateSocketsCallback
   * @param {WebSocket} socket The WebSocket instance.
   * @returns {T} The result of the callback for the given socket.
   */

  /**
   * Iterates over active WebSocket connections, optionally filtered by a tag, and executes a callback for each.
   * @template T
   * @param {IterateSocketsCallback<T>} callback The function to execute for each socket.
   * @param {string} [tag] An optional tag to filter which WebSockets to iterate over.
   * @returns {Array<T>} An array containing the return value of the callback for each socket.
   */
  iterateOverSockets (callback, tag = undefined) {
    const sockets = this.ctx.getWebSockets(tag)
    return sockets.map(socket => callback(socket))
  }

  /**
   * Extracts the client type and ID from a WebSocket's tags.
   * @param {WebSocket} ws The WebSocket instance.
   * @returns {{id: number | null, type: string}}
   */
  getClientInfo (ws) {
    return this.ctx.getTags(ws).reduce((info, tag) => {
      const [key, value] = tag.split(':')
      switch (key) {
        case websocketTags.TYPE:
          info.type = value
          break
        case websocketTags.ID:
          info.id = parseInt(value, 10)
          break
      }
      return info
    }, { id: null, type: deviceTags.UNKNOWN })
  }

  /**
   *
   * @param {WebSocket} ws
   * @param {string | ArrayBuffer} message
   * @returns
   */
  async webSocketMessage (ws, message) {
    // Determine clientType by checking which tag this WebSocket has
    const sender = this.getClientInfo(ws)

    try {
      const data = JSON.parse(message)
      console.debug(`[DO ${this.shortId}] Message from ${sender.type} (id: ${sender.id}):`, data)

      // Handle keep-alive pings
      if (data.type === 'ping') {
        console.debug(`[DO ${this.shortId}] Received ping from ${sender.type} (id: ${sender.id}).`)
        // Respond with a pong to let the client know the connection is active.
        ws.send(JSON.stringify({ type: 'pong' }))
        console.debug(`[DO ${this.shortId}] Sent pong to ${sender.type} (id: ${sender.id}).`)
        return
      }

      // New message routing logic
      const payload = data?.payload
      const close = () => {
        console.debug(`[DO ${this.shortId}] ${sender.type} (id: ${sender.id}) requested closure. Closing all connections.`)
        // Get all sockets currently in the session and close them to terminate the session.
        const closeReason = `${labels.SESSION_CLOSED_BY_CLIENT_PREFIX} ${sender.type} (id: ${sender.id})`
        this.iterateOverSockets((socket) => {
          socket.close(WsStatusCodes.NORMAL_CLOSURE, closeReason)
        })
      }

      const getParticipants = () => {
        const participants = this.iterateOverSockets(socket => this.getClientInfo(socket))

        ws.send(JSON.stringify({
          type: labels.PARTICIPANTS_LIST,
          participants
        }))
        console.debug(`[DO ${this.shortId}] Sent participants list to ${sender.type} (id: ${sender.id})`)
      }

      // Handle special commands within the payload
      switch (payload?.command) {
        case labels.CLOSE_CMD:
          close()
          return
        case labels.GET_PARTICIPANTS_CMD:
          getParticipants()
          return
      }

      // If the message was not a command, it must be a relay message.
      // Relay messages require a 'to' recipient and a 'payload'.
      const recipient = data?.to
      if (!recipient || !payload) {
        console.warn(`[DO ${this.shortId}] Invalid message format from ${sender.type} (id: ${sender.id}). Not a command and is missing 'to' or 'payload'.`)
        return
      }

      // Add sender information to the payload
      const messageToSend = JSON.stringify({ payload, from: sender })

      // Private message: 'to.id' is specified
      if (recipient.id !== undefined) {
        // Find the target socket by its ID tag
        const addressee = this
          .iterateOverSockets(
            socket => ({ socket, info: this.getClientInfo(socket) }),
            `${websocketTags.ID}:${recipient.id}`
          )
          .find(obj => obj.info.type === recipient.type)

        if (addressee) {
          const { socket, info } = addressee
          socket.send(messageToSend)
          console.debug(`[DO ${this.shortId}] Relayed private message from ${sender.type} (id: ${sender.id}) to ${info.type} (id: ${info.id})`)
          return // Message sent, we are done
        }
        console.warn(`[DO ${this.shortId}] Could not find recipient: ${recipient.type} (id: ${recipient.id})`)
      } else { // Public message to a client type
        const sentSockets = this.iterateOverSockets(socket => {
          // Don't send the message back to the sender
          if (socket !== ws) {
            socket.send(messageToSend)
            return true // Indicate that a message was sent
          }
        }, `${websocketTags.TYPE}:${recipient.type}`)
        const sentCount = sentSockets.filter(Boolean).length
        console.debug(`[DO ${this.shortId}] Relayed public message from ${sender.type} (id: ${sender.id}) to ${sentCount} ${recipient.type}(s)`)
      }
    } catch (e) {
      console.error(`[DO ${this.shortId}] Invalid JSON from ${sender.type} (id: ${sender.id}):`, message)
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
  async webSocketClose (ws, code, reason, wasClean) {
    // Method 1: Check all active WebSocket tags to identify this one
    const clientInfo = this.getClientInfo(ws)
    console.debug(`[DO ${this.shortId}] ${clientInfo.type} (id: ${clientInfo.id}) disconnected: ${reason} (code: ${code})`)

    // If a graceful shutdown was initiated by a tablet, do nothing further.
    if (!reason.startsWith(labels.SESSION_CLOSED_BY_CLIENT_PREFIX)) {
      switch (clientInfo.type) {
        case deviceTags.PC:
          // PC disconnected unexpectedly, close all tablet sockets.
          this.iterateOverSockets((socket) => {
            console.debug(`[DO ${this.shortId}] Also closing tablet because ${clientInfo.type} (id: ${clientInfo.id}) disconnected`)
            socket.close(WsStatusCodes.NORMAL_CLOSURE, `${clientInfo.type} (id: ${clientInfo.id}) disconnected`)
          }, labels.TABLET_TYPE)
          break
        case deviceTags.TABLET:
          // A tablet disconnected. If it was the last one, close the PC socket.
          if (this.ctx.getWebSockets(labels.TABLET_TYPE).length === 0) {
            const reason = `${labels.LAST_TABLET_DISCONNECTED} (was id: ${clientInfo.id})`
            console.debug(`[DO ${this.shortId}] ${reason}`)
            this.iterateOverSockets(pcSocket => {
              pcSocket.close(WsStatusCodes.NORMAL_CLOSURE, reason)
            }, labels.PC_TYPE)
          }
          break
      }
    }

    // Debug: Log current socket counts
    const allSockets = this.ctx.getWebSockets()
    console.debug(`[DO ${this.shortId}] Remaining sockets: ${allSockets.length} total`)
  }

  /**
   * Fetches the next client ID from storage, or initializes it.
   */
  async getNextTabletId () {
    this.nextTabletId = (await this.ctx.storage.get(labels.TABLET_ID_COUNTER)) || 0
  }

  async alarm () {
    console.debug(`[DO ${this.shortId}] Alarm triggered`)

    try {
      // Check if we have active WebSockets
      const allSockets = this.ctx.getWebSockets()

      if (allSockets.length > 0) {
        // We have active connections - set next keep-alive
        console.debug(`[DO ${this.shortId}] Keep-alive: ${allSockets.length} active connections`)
        await this.ctx.storage.setAlarm(Date.now() + this.keepAliveInterval)
      } else {
        // No active connections - session expired
        console.debug(`[DO ${this.shortId}] Session expired - cleaning up`)
        await this.ctx.storage.delete(labels.TABLET_CONNECTION_TOKEN)
      }
    } catch (e) {
      console.error(`[DO ${this.shortId}] Error in alarm handler:`, e)
    }
  }
}
