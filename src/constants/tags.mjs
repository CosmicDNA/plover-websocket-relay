const knownDeviceTags = Object.freeze({
  PC: "pc",
  TABLET: "tablet"
})

const deviceTags = Object.freeze({
  UNKNOWN: "unknown",
  ...knownDeviceTags
})

const labels = Object.freeze({
  TABLET_COUNTER: `${deviceTags.TABLET}Counter`,
  TABLET_CONNECTED: `${deviceTags.TABLET}_connected`,
  TABLET_JOINED: `${deviceTags.TABLET}_joined`,
  CLOSED_BY_TABLET: `Closed by ${deviceTags.TABLET}`,
  SECRET_TOKEN: 'secretToken',
  SYSTEM: "system",
  CONNECTION_ESTABLISHED: 'Connection established'
})

export {
  deviceTags,
  knownDeviceTags,
  labels
}