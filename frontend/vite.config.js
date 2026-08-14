import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/cytoscape/')) return 'cytoscape'
          if (id.includes('/node_modules/cytoscape-fcose/') ||
              id.includes('/node_modules/cose-base/') ||
              id.includes('/node_modules/layout-base/')) return 'graph-layout'
        },
      },
    },
  },
})
