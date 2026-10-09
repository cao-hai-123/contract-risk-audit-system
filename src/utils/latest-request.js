// A response may update UI state only while it belongs to the newest request.
export function createLatestRequest() {
  let sequence = 0
  let controller
  return {
    begin() {
      controller?.abort()
      controller = new AbortController()
      const id = ++sequence, signal = controller.signal
      return { signal, isCurrent: () => id === sequence && !signal.aborted }
    },
    cancel() { ++sequence; controller?.abort() }
  }
}

