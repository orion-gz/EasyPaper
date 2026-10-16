export function createReadingTrail(limit = 50) {
  const entries = []
  return {
    get last() { return entries.at(-1) },
    remember(value) {
      if (JSON.stringify(entries.at(-1)) !== JSON.stringify(value)) entries.push(structuredClone(value))
      if (entries.length > limit) entries.shift()
    },
    pop: () => entries.pop(),
    clear: () => { entries.length = 0 },
  }
}
