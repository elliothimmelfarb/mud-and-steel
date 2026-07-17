import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  server: {
    // Parallel sessions each run their own dev server: take the harness's
    // assigned port when given one, otherwise the usual vite default.
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
