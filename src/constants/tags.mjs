const knownDeviceTags = Object.freeze({
  PC: 'pc',
  TABLET: 'tablet'
})

const websocketTags = Object.freeze({
  TYPE: 'type',
  ID: 'id'
})

const deviceTags = Object.freeze({
  UNKNOWN: 'unknown',
  ...knownDeviceTags
})

const labels = Object.freeze({
  TABLET_ID_COUNTER: 'tabletIdCounter',
  TABLET_CONNECTED: `${deviceTags.TABLET}_connected`,
  // Generic session management labels
  TABLET_CONNECTION_TOKEN: 'tabletConnectionToken',
  PC_CONNECTION_TOKEN: 'pcConnectionToken',
  SESSION_CLOSED_BY_CLIENT_PREFIX: 'Session closed by',
  SESSION_CLOSED_BY_CLIENT_REQUEST: 'Session closed by client request',
  LAST_TABLET_DISCONNECTED: 'Last tablet disconnected',
  // System messages and types
  SYSTEM: 'system',
  CONNECTION_ESTABLISHED: 'Connection established',
  INITIALIZATION_SUCCESSFUL: 'Initialization successful',
  EXPECTED_WEBSOCKET: 'Expected WebSocket',
  INVALID_TOKEN: 'Invalid token',
  PARTICIPANTS_LIST: 'participants_list',
  PC_TYPE: `${websocketTags.TYPE}:${deviceTags.PC}`,
  TABLET_TYPE: `${websocketTags.TYPE}:${deviceTags.TABLET}`,
  GET_PARTICIPANTS_CMD: 'get_participants',
  CLOSE_CMD: 'close'
})

export {
  deviceTags,
  knownDeviceTags,
  labels,
  websocketTags
}
