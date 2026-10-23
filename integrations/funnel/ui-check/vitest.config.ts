import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Reuse the dashboard's existing test dependencies; do not alter the funnel lockfile.
const funnel = resolve('../test bclearn funnel/funnel-web')
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': funnel,
      'next/image': resolve('integrations/funnel/ui-check/NextImage.tsx'),
      'next/link': resolve('integrations/funnel/ui-check/NextLink.tsx'),
      '@stripe/stripe-js': resolve(funnel, 'node_modules/@stripe/stripe-js/lib/index.mjs'),
      react: resolve('node_modules/react'),
      'react-dom': resolve('node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    environmentOptions: { jsdom: { url: 'http://localhost:3000/' } },
    include: ['integrations/funnel/ui-check/flow.check.tsx'],
  },
})
