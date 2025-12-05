class SingletonViolation extends Error {
  constructor (message) {
    super(message)
    this.name = 'SingletonViolation'
  }
}

export default SingletonViolation
