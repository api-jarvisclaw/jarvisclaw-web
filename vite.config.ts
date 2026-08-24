import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
