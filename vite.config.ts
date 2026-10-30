import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        dashboard: resolve(projectRoot, 'index.html'),
        demoFunnel: resolve(projectRoot, 'demo-funnel.html'),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // The React Native SDK's tests mock 'react-native', which is not installed here.
    alias: {
      'react-native': resolve(
        projectRoot,
        'integrations/analytics-react-native/test/react-native.ts',
      ),
    },
  },
})
