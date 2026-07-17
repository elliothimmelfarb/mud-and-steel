import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    // Parallel sessions each run their own dev server; take the harness-assigned
    // PORT when present and fall back gracefully instead of fighting over 5173.
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
