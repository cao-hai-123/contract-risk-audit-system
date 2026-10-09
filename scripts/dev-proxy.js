// Preserve multipart streams and return an actionable JSON error on upstream failure.
// POST uploads are never replayed: the API may already have persisted their result.
export function createApiProxy(target) {
  return {
    target, changeOrigin: true, timeout: 0, proxyTimeout: 0,
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, _request, response) => {
        const cancel = () => { if (!response.writableEnded) outgoing.destroy() }
        response.once('close', cancel)
        response.once('finish', () => response.off('close', cancel))
      })
      proxy.on('error', (error, request, response) => {
        if (request?.aborted || response?.destroyed) {
          error.contractClientCancelled = true
          return
        }
        if (!response || response.headersSent || response.writableEnded) return
        const timeout = ['ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error.code)
        response.writeHead(timeout ? 504 : 503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ code: timeout ? 'api_timeout' : 'api_connection_interrupted',
          message: '合同解析 API 连接中断或暂时不可用。请检查运行 npm run dev 的终端与 MySQL 服务；服务恢复后先查看历史记录确认是否已完成，再重新上传。' }))
      })
    }
  }
}
