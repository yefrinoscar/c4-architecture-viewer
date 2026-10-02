import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

async function aiBridgePlugin(): Promise<Plugin> {
  const bridgeUrl = new URL('./server/go-api.mjs', import.meta.url).href
  const { createAiMiddleware } = await import(bridgeUrl) as {
    createAiMiddleware: () => Connect.NextHandleFunction
  }
  const middleware = createAiMiddleware()
  return {
    name: 'ai-same-origin-bridge',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig(async () => {
  return {
    plugins: [react(), await aiBridgePlugin()],
    server: { host: '127.0.0.1' },
    preview: { host: '127.0.0.1' },
  }
})
