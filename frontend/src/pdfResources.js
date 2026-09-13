// Emit companion resources locally for both web and desktop viewers.
const resources = import.meta.glob([
  '../node_modules/pdfjs-dist/cmaps/*.bcmap',
  '../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}',
  '../node_modules/pdfjs-dist/wasm/*.{wasm,js}',
  '../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/LICENSE*',
], { eager: true, query: '?url', import: 'default' })

function directory(fragment) {
  const url = Object.entries(resources).find(([path]) => path.includes(fragment) && !path.split('/').pop().startsWith('LICENSE'))?.[1]
  return url?.slice(0, url.lastIndexOf('/') + 1)
}

export const pdfResources = {
  cMapUrl: directory('/cmaps/'), cMapPacked: true,
  standardFontDataUrl: directory('/standard_fonts/'), wasmUrl: directory('/wasm/'),
}
