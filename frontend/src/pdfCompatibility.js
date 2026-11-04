// PDF.js legacy builds still require Promise.withResolvers in both realms.
// Preserve native implementations and the constructor semantics of the API.
if (typeof Promise.withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers() {
      let resolve
      let reject
      const promise = new this((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    },
  })
}
