import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:3001', ws: true, changeOrigin: false },
    },
  },
})
