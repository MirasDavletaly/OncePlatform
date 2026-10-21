import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The production build is written into internal/webui/dist and embedded into
// the Go binary. During development, API calls are proxied to the Go server.
const backend = 'http://localhost:8080'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      '/api': backend,
      '/oauth': backend,
      '/mcp': backend,
      '/.well-known': backend,
    },
  },
})
