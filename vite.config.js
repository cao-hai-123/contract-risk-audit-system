import { createLogger, defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createApiProxy } from './scripts/dev-proxy.js'

const logger = createLogger()
const logError = logger.error.bind(logger)
logger.error = (message, options) => {
  // Reset/switch-file aborts are intentional; real upstream failures stay visible.
  if (!options?.error?.contractClientCancelled) logError(message, options)
}

export default defineConfig({
  customLogger: logger,
  plugins: [vue()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    proxy: {
      '/api': createApiProxy(`http://127.0.0.1:${Number(process.env.PORT || 3001)}`)
    }
  }
})
