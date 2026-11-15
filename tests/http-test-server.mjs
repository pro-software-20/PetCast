/**
 * Ensures loopback servers used by contract tests release both their listener
 * and any keep-alive sockets. Node's server.close() alone does not always
 * close idle undici connections on Windows.
 */
export const listenLoopback = server => new Promise((resolve, reject) => {
  const onError = error => {
    server.off('error', onError)
    reject(error)
  }
  server.once('error', onError)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', onError)
    const address = server.address()
    if (!address || typeof address === 'string') {
      void closeLoopback(server).then(() => reject(new Error('Loopback server did not expose a TCP port.')))
      return
    }
    resolve(address.port)
  })
})

export const closeLoopback = async server => {
  // Available in supported Node versions; the optional call keeps the helper
  // compatible with the minimal Server fixture used by a few tests.
  server.closeIdleConnections?.()
  server.closeAllConnections?.()
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}
