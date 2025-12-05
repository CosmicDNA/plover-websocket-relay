const getNewToken = () => {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export default getNewToken
