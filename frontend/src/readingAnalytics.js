// Reading Analytics Tracker (Frontend)

const HEARTBEAT_INTERVAL_MS = 20000 // 20 seconds
const STORAGE_KEY_OFFLINE_QUEUE = 'easypaper_reading_heartbeat_offline_queue'

function createEmptyInteractionSummary() {
  return {
    scroll: 0,
    selection: 0,
    highlight: 0,
    underline: 0,
    memo: 0,
    question: 0,
    citationClick: 0,
    figureClick: 0,
    tableClick: 0,
    equationClick: 0,
  }
}

function getOfflineQueue() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_OFFLINE_QUEUE)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveOfflineQueue(queue) {
  try {
    localStorage.setItem(STORAGE_KEY_OFFLINE_QUEUE, JSON.stringify(queue.slice(-50)))
  } catch {}
}

export class ReadingAnalyticsTracker {
  constructor(apiBase = '/api') {
    this.apiBase = apiBase
    this.sessionId = null
    this.paperId = null
    this.version = 0
    this.startedAt = null
    this.activeReadingTime = 0
    this.pageSessionsMap = {} // page -> PageSession
    this.interactionSummary = createEmptyInteractionSummary()
    this.currentPage = 1
    this.heartbeatTimer = null
    this.activeTimer = null
    this.isTracking = false

    this.setupNetworkListeners()
  }

  setupNetworkListeners() {
    window.addEventListener('online', () => {
      this.syncOfflineQueue()
    })
  }

  async startSession(paperId, totalPages = 0) {
    this.stopSession()
    this.paperId = paperId
    this.version = 0
    this.activeReadingTime = 0
    this.pageSessionsMap = {}
    this.interactionSummary = createEmptyInteractionSummary()
    this.currentPage = 1
    this.startedAt = new Date().toISOString()
    this.isTracking = true

    try {
      const res = await fetch(`${this.apiBase}/library/${paperId}/reading-session/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totalPages }),
      })
      if (res.ok) {
        const data = await res.json()
        this.sessionId = data.sessionId
        this.version = data.version || 0
        if (data.merged) {
          this.activeReadingTime = data.activeReadingTime || 0
          this.currentPage = data.currentPage || 1
          this.interactionSummary = {
            ...createEmptyInteractionSummary(),
            ...(data.interactionSummary || {}),
          }
          this.pageSessionsMap = {}
          for (const pageSession of (data.pageSessions || [])) {
            this.pageSessionsMap[pageSession.page] = {
              ...pageSession,
              interaction: {
                ...createEmptyInteractionSummary(),
                ...(pageSession.interaction || {}),
              },
            }
          }
        }
      } else {
        this.sessionId = 'local-' + Date.now()
      }
    } catch {
      this.sessionId = 'local-' + Date.now()
    }

    this.startTimers()
  }

  startTimers() {
    if (this.activeTimer) clearInterval(this.activeTimer)
    this.activeTimer = setInterval(() => {
      this.tickActiveReadingTime()
    }, 1000)

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat()
    }, HEARTBEAT_INTERVAL_MS)
  }

  stopSession() {
    if (this.activeTimer) {
      clearInterval(this.activeTimer)
      this.activeTimer = null
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.isTracking && this.sessionId && this.paperId) {
      this.sendEndSession()
    }
    this.isTracking = false
  }

  setCurrentPage(pageNumber) {
    const now = Date.now()
    if (this.pageSessionsMap[this.currentPage]) {
      this.pageSessionsMap[this.currentPage].leaveTime = now
    }
    this.currentPage = pageNumber
    this.ensurePageSession(pageNumber)
  }

  ensurePageSession(pageNumber) {
    if (!this.pageSessionsMap[pageNumber]) {
      this.pageSessionsMap[pageNumber] = {
        page: pageNumber,
        enterTime: Date.now(),
        leaveTime: Date.now(),
        visibleTime: 0,
        activeTime: 0,
        scrollCoverage: 0.0,
        interaction: createEmptyInteractionSummary(),
      }
    }
    return this.pageSessionsMap[pageNumber]
  }

  tickActiveReadingTime() {
    if (!this.isTracking || !this.paperId) return
    // Active Reading Condition: tab visible & window focused
    if (document.visibilityState !== 'visible' || !document.hasFocus()) return

    this.activeReadingTime += 1
    const ps = this.ensurePageSession(this.currentPage)
    ps.activeTime += 1
    ps.visibleTime += 1
    ps.leaveTime = Date.now()
  }

  trackScroll(pageNumber, pageElement = null, containerElement = null, isContinuousView = false, countInteraction = true) {
    if (!this.isTracking) return
    const ps = this.ensurePageSession(pageNumber)
    if (countInteraction) {
      ps.interaction.scroll += 1
      this.interactionSummary.scroll += 1
    }

    // Calculate Scroll Coverage
    if (pageElement && containerElement) {
      let coverage = 0
      if (isContinuousView) {
        const pageRect = pageElement.getBoundingClientRect()
        const containerRect = containerElement.getBoundingClientRect()

        const visibleBottom = Math.max(pageRect.top, Math.min(pageRect.bottom, containerRect.bottom))

        if (pageRect.height > 0) {
          coverage = (visibleBottom - pageRect.top) / pageRect.height
        }
      } else {
        const scrollTop = containerElement.scrollTop || 0
        const scrollHeight = containerElement.scrollHeight || 1
        const clientHeight = containerElement.clientHeight || 1
        coverage = (scrollTop + clientHeight) / scrollHeight
      }
      ps.scrollCoverage = Math.max(ps.scrollCoverage, Math.min(1.0, coverage))
    }
  }

  trackInteraction(type, pageNumber = this.currentPage) {
    if (!this.isTracking) return
    const ps = this.ensurePageSession(pageNumber)

    if (type in ps.interaction) {
      ps.interaction[type] += 1
    }
    if (type in this.interactionSummary) {
      this.interactionSummary[type] += 1
    }
  }

  buildPayload() {
    this.version += 1
    const pageSessions = Object.values(this.pageSessionsMap)
    return {
      sessionId: this.sessionId,
      paperId: this.paperId,
      version: this.version,
      currentPage: this.currentPage,
      activeReadingTime: this.activeReadingTime,
      pageSessions,
      interactionSummary: this.interactionSummary,
    }
  }

  async sendHeartbeat() {
    if (!this.isTracking || !this.paperId || !this.sessionId) return
    const payload = this.buildPayload()

    try {
      const res = await fetch(`${this.apiBase}/library/${this.paperId}/reading-session/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        this.enqueueOfflinePayload(payload, 'heartbeat')
      } else {
        const result = await res.json()
        this.syncOfflineQueue()
        return result
      }
    } catch {
      this.enqueueOfflinePayload(payload, 'heartbeat')
    }
  }

  async sendEndSession() {
    const payload = this.buildPayload()
    try {
      const res = await fetch(this.apiBase + "/library/" + this.paperId + "/reading-session/end", {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) this.enqueueOfflinePayload(payload, 'end')
    } catch {
      this.enqueueOfflinePayload(payload, 'end')
    }
  }

  enqueueOfflinePayload(payload, type = 'heartbeat') {
    const queue = getOfflineQueue()
    queue.push({ type, payload })
    saveOfflineQueue(queue)
  }

  async syncOfflineQueue() {
    const queue = getOfflineQueue()
    if (queue.length === 0) return

    const remaining = []
    for (const queuedItem of queue) {
      const type = queuedItem.type || 'heartbeat'
      const payload = queuedItem.payload || queuedItem
      try {
        const endpoint = type === 'end' ? 'end' : 'heartbeat'
        const res = await fetch(this.apiBase + '/library/' + payload.paperId + '/reading-session/' + endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!res.ok) remaining.push(queuedItem)
      } catch {
        remaining.push(queuedItem)
      }
    }
    saveOfflineQueue(remaining)
  }
}

export const globalAnalyticsTracker = new ReadingAnalyticsTracker()
