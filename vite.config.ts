import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // Never inline an asset as a data: URI. The deployed CSP sets `font-src 'self'`, and
    // a data: URI is not 'self' — so Vite inlining one small subset (it does this under
    // 4 KiB by default) makes the browser refuse exactly that face while every other one
    // loads. The console error names a base64 blob, which points at nothing.
    assetsInlineLimit: 0,
  },
  server: {
    // Fixed rather than "next free port". A stray fallback port is how a stubbed dev
    // harness ends up pointed at nothing and the page comes up blank, which reads as a
    // UI bug rather than a wrong port.
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
