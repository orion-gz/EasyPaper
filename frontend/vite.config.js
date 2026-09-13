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
    assetsInlineLimit: path => path.includes('/pdfjs-dist/') ? false : undefined,
    rollupOptions: {
      output: {
        // PDF.js requests companion resources by their original file names.
        assetFileNames(asset) {
          const name = asset.names?.[0] || asset.name || ''
          if (/\.(bcmap|pfb|ttf|wasm)$/.test(name) || /^(openjpeg|qcms|jbig2|quickjs|LICENSE)/.test(name)) {
            return 'assets/pdfjs/[name][extname]'
          }
          return 'assets/[name]-[hash][extname]'
        },
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
