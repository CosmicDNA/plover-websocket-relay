import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import HttpMethods from '../node_modules/http-methods-constants/index'
import { StatusCodes } from '../node_modules/http-status-codes/build/cjs/status-codes'
import WsStatusCodes from '../node_modules/websocket-event-codes/index'
import searchParams from './constants/search-params.mjs'
import slugs from './constants/slugs.mjs'
import { deviceTags, labels, websocketTags } from './constants/tags.mjs'
import SingletonViolation from './errors/singleton-violation.mjs'
import { RelaySession } from './relay-session.mjs'

const MOCK_TABLET_TOKEN = 'mock-tablet-token'
const MOCK_PC_TOKEN = 'mock-pc-token'

// Mock 'cloudflare:workers' to provide a base class for DurableObject
vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor (ctx, env) {
      expect(ctx).toBeDefined()
      // This is a mock constructor. In the real Cloudflare environment, this would
      // initialize the base Durable Object, but for our tests, we just need a valid
      // class to extend and a constructor to satisfy the `super(ctx, env)` call.
    }
  }
}))

// Mock the token generator
vi.mock('./token-generator.mjs', () => ({
  default: vi.fn(() => 'new-mock-token')
}))

// Mock WebSocketPair
const mockSockets = new Map()
const createMockWebSocket = () => ({
  send: vi.fn(),
  close: vi.fn(),
  accept: vi.fn() // Cloudflare-specific method
})

let lastMockSocket
global.WebSocketPair = class WebSocketPair {
  constructor () {
    // Create a new pair for each instantiation
    this.client = createMockWebSocket() // The one returned to the client
    this.server = createMockWebSocket() // The one the DO interacts with
    lastMockSocket = this // Store the latest created pair for assertions
  }
}

describe('RelaySession Durable Object', () => {
  let state
  let env
  let relaySession

  // Store the original Response object
  const OriginalResponse = global.Response

  beforeAll(() => {
    // Mock the global Response object to allow a 101 status, which is not
    // supported in the default Node.js/undici environment but is required
    // for Cloudflare Workers WebSocket upgrades.
    global.Response = class MockResponse {
      constructor (body, init) {
        this.body = body
        this.status = init?.status
        this.webSocket = init?.webSocket
        this.headers = { get: () => null } // Simple mock for headers
        this.text = async () => Promise.resolve(this.body)
      }
    }

    // Spy on console methods to control logging during tests.
    // To see logs, comment out the corresponding line.
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    // vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterAll(() => {
    // Restore original console methods after all tests have run.
    vi.restoreAllMocks()
    // Restore the original Response object
    global.Response = OriginalResponse
  })

  beforeEach(() => {
    const storage = new Map()
    mockSockets.clear()

    state = {
      id: 'test-do-id',
      storage: {
        get: vi.fn(key => storage.get(key)),
        put: vi.fn((key, value) => storage.set(key, value)),
        delete: vi.fn(key => storage.delete(key)),
        setAlarm: vi.fn(),
        deleteAlarm: vi.fn()
      },
      getWebSockets: vi.fn(tag => {
        if (!tag) return Array.from(mockSockets.keys())
        const sockets = []
        for (const [socket, tags] of mockSockets.entries()) {
          if (tags.includes(tag)) {
            sockets.push(socket)
          }
        }
        return sockets
      }),
      acceptWebSocket: vi.fn((socket, tags) => {
        mockSockets.set(socket, tags)
      }),
      getTags: vi.fn(socket => mockSockets.get(socket) || [])
    }
    env = { RELAY_SESSION: {} }
    relaySession = new RelaySession(state, env)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should initialize properties correctly', () => {
      expect(relaySession.ctx).toBe(state)
      expect(relaySession.sessionAlarmTime).toBe(5 * 60 * 1000)
      expect(relaySession.keepAliveInterval).toBe(30 * 1000)
    })
  })

  describe('initialize', () => {
    it('should store tokens and set an alarm', async () => {
      await relaySession.initialize(MOCK_TABLET_TOKEN, MOCK_PC_TOKEN)
      expect(state.storage.put).toHaveBeenCalledWith(labels.TABLET_CONNECTION_TOKEN, MOCK_TABLET_TOKEN)
      expect(state.storage.put).toHaveBeenCalledWith(labels.PC_CONNECTION_TOKEN, MOCK_PC_TOKEN)
      expect(state.storage.setAlarm).toHaveBeenCalled()
    })
  })

  describe('enforceSingleton', () => {
    it('should throw SingletonViolation if a device of the same type is already connected', () => {
      state.getWebSockets.mockReturnValue([{}]) // Simulate one existing socket
      expect(() => relaySession.enforceSingleton(deviceTags.PC)).toThrow(SingletonViolation)
      expect(() => relaySession.enforceSingleton(deviceTags.PC)).toThrow('A pc is already connected to this session.')
    })

    it('should not throw if no device of the same type is connected', () => {
      state.getWebSockets.mockReturnValue([]) // No existing sockets
      expect(() => relaySession.enforceSingleton(deviceTags.PC)).not.toThrow()
    })
  })

  describe('fetch', () => {
    it('should handle POST initialization', async () => {
      const request = new Request('https://test.com', {
        method: HttpMethods.POST,
        body: JSON.stringify({
          tabletConnectionToken: MOCK_TABLET_TOKEN,
          pcConnectionToken: MOCK_PC_TOKEN
        })
      })
      const response = await relaySession.fetch(request)
      expect(response.status).toBe(StatusCodes.OK)
      expect(await response.text()).toBe(labels.INITIALIZATION_SUCCESSFUL)
      expect(state.storage.put).toHaveBeenCalledTimes(2) // 2 tokens
      expect(state.storage.setAlarm).toHaveBeenCalled()
    })

    it('should reject non-WebSocket upgrade requests', async () => {
      const request = new Request('https://test.com', { method: 'GET' })
      const response = await relaySession.fetch(request)
      expect(response.status).toBe(StatusCodes.UPGRADE_REQUIRED)
      expect(await response.text()).toBe(labels.EXPECTED_WEBSOCKET)
    })

    describe('WebSocket Upgrade', () => {
      const headers = { Upgrade: 'websocket' }

      it('should reject connection with an unknown path', async () => {
        const request = new Request('https://test.com/unknown', { headers })
        const response = await relaySession.fetch(request)
        expect(response.status).toBe(StatusCodes.SWITCHING_PROTOCOLS)
        expect(state.acceptWebSocket).toHaveBeenCalledWith(expect.anything(), [
          `${websocketTags.TYPE}:${deviceTags.UNKNOWN}`,
          `${websocketTags.ID}:null`
        ])
      })

      describe('/connect (PC)', () => {
        it('should reject connection with invalid token', async () => {
          await state.storage.put(labels.PC_CONNECTION_TOKEN, MOCK_PC_TOKEN)
          const request = new Request(`https://test.com/${slugs.CONNECT}?${searchParams.TOKEN}=invalid`, { headers })
          const response = await relaySession.fetch(request)
          expect(response.status).toBe(StatusCodes.FORBIDDEN)
          expect(await response.text()).toBe(labels.INVALID_TOKEN)
          expect(lastMockSocket.server.close).toHaveBeenCalledWith(WsStatusCodes.POLICY_VIOLATION, labels.INVALID_TOKEN)
        })

        it('should reject if a PC is already connected', async () => {
          await state.storage.put(labels.PC_CONNECTION_TOKEN, MOCK_PC_TOKEN)
          state.getWebSockets.mockReturnValue([{}]) // Simulate existing PC

          const request = new Request(`https://test.com/${slugs.CONNECT}?${searchParams.TOKEN}=${MOCK_PC_TOKEN}`, { headers })
          const response = await relaySession.fetch(request)

          expect(response.status).toBe(StatusCodes.CONFLICT)
          expect(await response.text()).toContain('already connected')
          expect(lastMockSocket.server.close).toHaveBeenCalledWith(WsStatusCodes.POLICY_VIOLATION, expect.stringContaining('already connected'))
        })

        it('should successfully connect a PC', async () => {
          await state.storage.put(labels.PC_CONNECTION_TOKEN, MOCK_PC_TOKEN)
          const request = new Request(`https://test.com/${slugs.CONNECT}?${searchParams.TOKEN}=${MOCK_PC_TOKEN}`, { headers })
          const response = await relaySession.fetch(request)

          expect(response.status).toBe(StatusCodes.SWITCHING_PROTOCOLS)
          expect(response.webSocket).toBe(lastMockSocket.client)
          expect(state.acceptWebSocket).toHaveBeenCalledWith(expect.anything(), [
            `${websocketTags.TYPE}:${deviceTags.PC}`,
            `${websocketTags.ID}:0`
          ])
          expect(lastMockSocket.server.send).toHaveBeenCalledWith(JSON.stringify({
            clientType: deviceTags.PC,
            id: 0,
            type: labels.SYSTEM,
            message: labels.CONNECTION_ESTABLISHED
          }))
        })

        it('should close the server socket if singleton violation happens after WebSocketPair creation', async () => {
          // This test covers the server?.close() branch in the catch block.
          // We simulate this by making enforceSingleton throw on its first call.
          const enforceSingletonSpy = vi.spyOn(relaySession, 'enforceSingleton')
            .mockImplementation(() => { throw new SingletonViolation('A pc is already connected to this session.') })

          const request = new Request(`https://test.com/${slugs.CONNECT}?${searchParams.TOKEN}=${MOCK_PC_TOKEN}`, { headers })
          await state.storage.put(labels.PC_CONNECTION_TOKEN, MOCK_PC_TOKEN)
          // The error is thrown inside, so we don't need the response.
          await relaySession.fetch(request)

          expect(enforceSingletonSpy).toHaveBeenCalledTimes(1)
          expect(lastMockSocket.server.close).toHaveBeenCalledWith(WsStatusCodes.POLICY_VIOLATION, expect.stringContaining('already connected'))
        })
      })

      describe('/join (Tablet)', () => {
        beforeEach(async () => {
          // A PC must be connected first
          const pcSocket = createMockWebSocket()
          mockSockets.set(pcSocket, [`${websocketTags.TYPE}:${deviceTags.PC}`, `${websocketTags.ID}:0`])
          await state.storage.put(labels.TABLET_CONNECTION_TOKEN, MOCK_TABLET_TOKEN)
        })

        it('should reject connection with invalid token', async () => {
          const request = new Request(`https://test.com/${slugs.JOIN}?${searchParams.TOKEN}=invalid`, { headers })
          const response = await relaySession.fetch(request)
          expect(response.status).toBe(StatusCodes.FORBIDDEN)
          expect(await response.text()).toBe(labels.INVALID_TOKEN)
          expect(lastMockSocket.server.close).toHaveBeenCalledWith(WsStatusCodes.POLICY_VIOLATION, labels.INVALID_TOKEN)
        })

        it('should successfully connect a tablet', async () => {
          await state.storage.put(labels.TABLET_ID_COUNTER, 5)
          const request = new Request(`https://test.com/${slugs.JOIN}?${searchParams.TOKEN}=${MOCK_TABLET_TOKEN}`, { headers })
          const response = await relaySession.fetch(request)

          expect(response.status).toBe(StatusCodes.SWITCHING_PROTOCOLS)
          expect(response.webSocket).toBe(lastMockSocket.client)

          // Check alarms
          expect(state.storage.deleteAlarm).toHaveBeenCalled()
          expect(state.storage.setAlarm).toHaveBeenCalled()

          // Check ID assignment and storage update
          expect(state.storage.put).toHaveBeenCalledWith(labels.TABLET_ID_COUNTER, 6)

          // Check token rotation
          expect(state.storage.put).toHaveBeenCalledWith(labels.TABLET_CONNECTION_TOKEN, 'new-mock-token')

          // Check WebSocket acceptance
          expect(state.acceptWebSocket).toHaveBeenCalledWith(expect.anything(), [
            `${websocketTags.TYPE}:${deviceTags.TABLET}`,
            `${websocketTags.ID}:5`
          ])

          // Check welcome message to tablet
          expect(lastMockSocket.server.send).toHaveBeenCalledWith(JSON.stringify({
            clientType: deviceTags.TABLET,
            id: 5,
            type: labels.SYSTEM,
            message: labels.CONNECTION_ESTABLISHED
          }))

          // Check notification to PC
          const pcSocket = state.getWebSockets(`${websocketTags.TYPE}:${deviceTags.PC}`)[0]
          expect(pcSocket.send).toHaveBeenCalledWith(expect.stringContaining(`"type":"${labels.TABLET_CONNECTED}"`))
          expect(pcSocket.send).toHaveBeenCalledWith(expect.stringContaining('"id":5'))
          expect(pcSocket.send).toHaveBeenCalledWith(expect.stringContaining('"newTabletToken":"new-mock-token"'))
        })
      })

      it('should handle unexpected errors during fetch', async () => {
        const error = new Error('Unexpected')
        state.storage.get.mockRejectedValue(error)
        const request = new Request(`https://test.com/${slugs.CONNECT}?${searchParams.TOKEN}=${MOCK_PC_TOKEN}`, { headers })
        const response = await relaySession.fetch(request)
        expect(response.status).toBe(StatusCodes.INTERNAL_SERVER_ERROR)
      })
    })
  })

  describe('iterateOverSockets', () => {
    it('should iterate over all sockets when no tag is provided', () => {
      const socket1 = { id: 1 }
      const socket2 = { id: 2 }
      mockSockets.set(socket1, ['type:pc'])
      mockSockets.set(socket2, ['type:tablet'])
      const callback = vi.fn(socket => socket.id)

      const results = relaySession.iterateOverSockets(callback)
      expect(callback).toHaveBeenCalledTimes(2)
      expect(results).toEqual([1, 2])
    })

    it('should iterate over tagged sockets when a tag is provided', () => {
      const socket1 = { id: 1 }
      const socket2 = { id: 2 }
      mockSockets.set(socket1, ['type:pc'])
      mockSockets.set(socket2, ['type:tablet'])
      const callback = vi.fn(socket => socket.id)

      const results = relaySession.iterateOverSockets(callback, 'type:pc')
      expect(callback).toHaveBeenCalledTimes(1)
      expect(callback).toHaveBeenCalledWith(socket1)
      expect(results).toEqual([1])
    })
  })

  describe('getClientInfo', () => {
    it('should extract type and ID from tags', () => {
      const ws = {}
      state.getTags.mockReturnValue([`${websocketTags.TYPE}:${deviceTags.TABLET}`, `${websocketTags.ID}:123`])
      const info = relaySession.getClientInfo(ws)
      expect(info).toEqual({ type: deviceTags.TABLET, id: 123 })
    })

    it('should return defaults for missing tags', () => {
      const ws = {}
      state.getTags.mockReturnValue([])
      const info = relaySession.getClientInfo(ws)
      expect(info).toEqual({ type: deviceTags.UNKNOWN, id: null })
    })
  })

  describe('webSocketMessage', () => {
    let pcSocket
    let tabletSocket1
    let tabletSocket2

    beforeEach(() => {
      pcSocket = { send: vi.fn(), close: vi.fn(), id: 'pc' }
      tabletSocket1 = { send: vi.fn(), close: vi.fn(), id: 'tablet1' }
      tabletSocket2 = { send: vi.fn(), close: vi.fn(), id: 'tablet2' }

      mockSockets.set(pcSocket, [`${websocketTags.TYPE}:${deviceTags.PC}`, `${websocketTags.ID}:0`])
      mockSockets.set(tabletSocket1, [`${websocketTags.TYPE}:${deviceTags.TABLET}`, `${websocketTags.ID}:1`])
      mockSockets.set(tabletSocket2, [`${websocketTags.TYPE}:${deviceTags.TABLET}`, `${websocketTags.ID}:2`])
    })

    it('should handle invalid JSON', async () => {
      await relaySession.webSocketMessage(pcSocket, 'not-json')
      // No crash, just an error log (which is mocked)
      expect(pcSocket.send).not.toHaveBeenCalled()
    })

    it('should handle ping and send pong', async () => {
      const message = JSON.stringify({ type: 'ping' })
      await relaySession.webSocketMessage(pcSocket, message)
      expect(pcSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }))
    })

    it('should ignore messages with missing "to" or "payload"', async () => {
      await relaySession.webSocketMessage(pcSocket, JSON.stringify({ to: {} })) // missing payload
      await relaySession.webSocketMessage(pcSocket, JSON.stringify({ payload: {} })) // missing to
      expect(pcSocket.send).not.toHaveBeenCalled()
      expect(tabletSocket1.send).not.toHaveBeenCalled()
    })

    it('should handle "close" command', async () => {
      const message = JSON.stringify({ to: {}, payload: { command: labels.CLOSE_CMD } })
      await relaySession.webSocketMessage(tabletSocket1, message)

      const closeReason = `${labels.SESSION_CLOSED_BY_CLIENT_PREFIX} ${deviceTags.TABLET} (id: 1)`
      expect(pcSocket.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
      expect(tabletSocket1.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
      expect(tabletSocket2.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
    })

    it('should handle "get_participants" command', async () => {
      const message = JSON.stringify({ to: {}, payload: { command: labels.GET_PARTICIPANTS_CMD } })
      await relaySession.webSocketMessage(pcSocket, message)

      const expectedParticipants = [
        { type: deviceTags.PC, id: 0 },
        { type: deviceTags.TABLET, id: 1 },
        { type: deviceTags.TABLET, id: 2 }
      ]

      const expectedMessage = {
        type: labels.PARTICIPANTS_LIST,
        participants: expect.arrayContaining(expectedParticipants.map(p => expect.objectContaining(p)))
      }

      const sentMessage = JSON.parse(pcSocket.send.mock.calls[0][0])
      expect(sentMessage).toEqual(expectedMessage)
    })

    it('should relay a private message to a specific client', async () => {
      const payload = { data: 'private hello' }
      const message = JSON.stringify({
        to: { type: deviceTags.TABLET, id: 2 },
        payload
      })

      await relaySession.webSocketMessage(pcSocket, message)

      const expectedMessage = {
        ...payload,
        from: expect.objectContaining({ type: deviceTags.PC, id: 0 })
      }

      const sentMessage = JSON.parse(tabletSocket2.send.mock.calls[0][0])
      expect(sentMessage).toEqual(expectedMessage)
      expect(tabletSocket1.send).not.toHaveBeenCalled()
      expect(pcSocket.send).not.toHaveBeenCalled()
    })

    it('should warn if private message recipient is not found', async () => {
      const payload = { data: 'private hello' }
      const message = JSON.stringify({
        to: { type: deviceTags.TABLET, id: 99 }, // Non-existent ID
        payload
      })

      await relaySession.webSocketMessage(pcSocket, message)
      expect(tabletSocket1.send).not.toHaveBeenCalled()
      expect(tabletSocket2.send).not.toHaveBeenCalled()
    })

    it('should relay a public message to all clients of a type', async () => {
      const payload = { data: 'public hello' }
      const message = JSON.stringify({
        to: { type: deviceTags.TABLET },
        payload
      })

      await relaySession.webSocketMessage(pcSocket, message)

      const expectedMessage = {
        ...payload,
        from: expect.objectContaining({ type: deviceTags.PC, id: 0 })
      }

      const sentMessage1 = JSON.parse(tabletSocket1.send.mock.calls[0][0])
      const sentMessage2 = JSON.parse(tabletSocket2.send.mock.calls[0][0])
      expect(sentMessage1).toEqual(expectedMessage)
      expect(sentMessage2).toEqual(expectedMessage)
      // Should not send back to sender
      expect(pcSocket.send).not.toHaveBeenCalled()
    })

    it('should return true for each socket a public message is sent to', async () => {
      const payload = { data: 'public hello' }
      const message = JSON.stringify({
        to: { type: deviceTags.TABLET },
        payload
      })

      // Spy on the method to check its return value
      const iterateSpy = vi.spyOn(relaySession, 'iterateOverSockets')

      await relaySession.webSocketMessage(pcSocket, message)

      // The spy is called, and its return value should contain `true` for each sent message.
      // There are 2 tablets, so we expect two `true` values.
      expect(iterateSpy.mock.results[0].value).toEqual([true, true])
    })
  })

  describe('webSocketClose', () => {
    let pcSocket
    let tabletSocket1
    let tabletSocket2

    beforeEach(() => {
      pcSocket = { send: vi.fn(), close: vi.fn(), id: 'pc' }
      tabletSocket1 = { send: vi.fn(), close: vi.fn(), id: 'tablet1' }
      tabletSocket2 = { send: vi.fn(), close: vi.fn(), id: 'tablet2' }

      mockSockets.set(pcSocket, [`${websocketTags.TYPE}:${deviceTags.PC}`, `${websocketTags.ID}:0`])
      mockSockets.set(tabletSocket1, [`${websocketTags.TYPE}:${deviceTags.TABLET}`, `${websocketTags.ID}:1`])
    })

    it('should do nothing if close was initiated by client command', async () => {
      const reason = `${labels.SESSION_CLOSED_BY_CLIENT_PREFIX} tablet (id: 1)`
      await relaySession.webSocketClose(tabletSocket1, 1000, reason, true)
      expect(pcSocket.close).not.toHaveBeenCalled()
    })

    it('should close all tablets if the PC disconnects', async () => {
      mockSockets.set(tabletSocket2, [`${websocketTags.TYPE}:${deviceTags.TABLET}`, `${websocketTags.ID}:2`])

      await relaySession.webSocketClose(pcSocket, 1001, 'PC disconnected', false)

      const closeReason = `${deviceTags.PC} (id: 0) disconnected`
      expect(tabletSocket1.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
      expect(tabletSocket2.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
    })

    it('should close a single tablet if the PC disconnects', async () => {
      // Only tabletSocket1 is connected in the beforeEach setup

      await relaySession.webSocketClose(pcSocket, 1001, 'PC disconnected', false)

      const closeReason = `${deviceTags.PC} (id: 0) disconnected`
      expect(tabletSocket1.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
    })

    it('should not close PC if a tablet disconnects but others remain', async () => {
      mockSockets.set(tabletSocket2, [`${websocketTags.TYPE}:${deviceTags.TABLET}`, `${websocketTags.ID}:2`])

      // Simulate the runtime behavior: when getWebSockets is called inside the handler,
      // the closing socket (tabletSocket1) is no longer present in the list.
      state.getWebSockets.mockReturnValue([tabletSocket2])

      await relaySession.webSocketClose(tabletSocket1, 1001, 'Tablet 1 disconnected', false)

      expect(pcSocket.close).not.toHaveBeenCalled()
    })

    it('should close PC if the last tablet disconnects', async () => {
      // Simulate that tablet1 is the only tablet connected
      state.getWebSockets.mockImplementation((tag) => {
        // When checking for remaining tablets, return an empty array.
        if (tag === labels.TABLET_TYPE) return []
        // When iterating to close the PC, return the PC socket.
        if (tag === labels.PC_TYPE) return [pcSocket]
        // Handle the final call with no tag.
        return []
      })

      await relaySession.webSocketClose(tabletSocket1, 1001, 'Tablet disconnected', false)

      const closeReason = `${labels.LAST_TABLET_DISCONNECTED} (was id: 1)`
      expect(pcSocket.close).toHaveBeenCalledWith(WsStatusCodes.NORMAL_CLOSURE, closeReason)
    })

    it('should handle disconnection of an unknown client type gracefully', async () => {
      const unknownSocket = { id: 'unknown' }
      mockSockets.set(unknownSocket, [`${websocketTags.TYPE}:${deviceTags.UNKNOWN}`, `${websocketTags.ID}:-1`])

      // No expect, just ensuring it doesn't crash
      await relaySession.webSocketClose(unknownSocket, 1001, 'Unknown disconnected', false)
      expect(true).toBe(true)
    })
  })

  describe('getNextTabletId', () => {
    it('should initialize counter to 0 if not in storage', async () => {
      state.storage.get.mockResolvedValue(undefined)
      await relaySession.getNextTabletId()
      expect(relaySession.nextTabletId).toBe(0)
    })

    it('should retrieve the counter from storage if it exists', async () => {
      state.storage.get.mockResolvedValue(42)
      await relaySession.getNextTabletId()
      expect(relaySession.nextTabletId).toBe(42)
    })
  })

  describe('alarm', () => {
    it('should set a new keep-alive alarm if sockets are connected', async () => {
      mockSockets.set({}, []) // Add a mock socket
      await relaySession.alarm()
      expect(state.storage.setAlarm).toHaveBeenCalled()
      expect(state.storage.delete).not.toHaveBeenCalled()
    })

    it('should clean up storage if no sockets are connected (session expired)', async () => {
      // No sockets in mockSockets
      await relaySession.alarm()
      expect(state.storage.delete).toHaveBeenCalledWith(labels.TABLET_CONNECTION_TOKEN)
      expect(state.storage.setAlarm).not.toHaveBeenCalled()
    })
  })
})
