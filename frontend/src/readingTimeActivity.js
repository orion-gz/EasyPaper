export const READING_TIME_IDLE_MS = 60_000

export function createReadingTimeActivityTracker({
  idleMs = READING_TIME_IDLE_MS,
  now = () => Date.now(),
} = {}) {
  let activityAt = { reading: 0, chat: 0 }

  function record(category, at = now()) {
    if (category !== 'reading' && category !== 'chat') return
    activityAt[category] = at
  }

  function reset(category = 'reading', at = now()) {
    activityAt = { reading: 0, chat: 0 }
    record(category, at)
  }

  function getCategory({ chatAvailable = true, at = now() } = {}) {
    const candidates = [
      ['reading', activityAt.reading],
      ...(chatAvailable ? [['chat', activityAt.chat]] : []),
    ].filter(([, timestamp]) => timestamp > 0)

    if (candidates.length === 0) return null
    const [category, timestamp] = candidates.reduce((latest, item) => item[1] > latest[1] ? item : latest)
    return at - timestamp <= idleMs ? category : null
  }

  return { record, reset, getCategory }
}

export const globalReadingTimeActivityTracker = createReadingTimeActivityTracker()
