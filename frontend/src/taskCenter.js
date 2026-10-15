import { icon } from './icons.js'
import { getDocumentTasksAPI, cancelDocumentTaskAPI, retryDocumentTaskAPI } from './api.js'
import { t } from './i18n.js'
import { readerFeatureEnabled, onReaderPreferences } from './readerPreferences.js'

const activeStatuses = new Set(['queued', 'running', 'retry_wait'])
const retryKinds = new Set(['translate', 'keywords', 'summary', 'primer', 'chapter_summary', 'full_summary', 'classification'])
function taskStatus(task, pending) {
  if (pending || (task.cancel_requested && activeStatuses.has(task.status))) return t('viewer:comfort.cancelling')
  return ({ queued: t('viewer:comfort.queued'), running: t('viewer:comfort.running'), retry_wait: t('viewer:comfort.retryWait'), succeeded: t('viewer:comfort.succeeded'), partial_failed: t('viewer:comfort.partialFailed'), failed: t('viewer:comfort.failed'), cancelled: t('viewer:comfort.cancelled') })[task.status] || task.status
}
function taskKind(task) {
  return ({ translate: t('viewer:comfort.translation'), parse: t('viewer:comfort.parse'), keywords: t('viewer:comfort.keywords'), summary: t('viewer:comfort.summary'), chapter_summary: t('viewer:comfort.summary'), full_summary: t('viewer:comfort.summary'), primer: t('viewer:comfort.primer'), classification: t('viewer:comfort.classification') })[task.kind] || task.kind
}
export function installTaskCenter({ shell, mount, navigate, toast }) {
  const toggle = document.createElement('button')
  toggle.id = 'reader-tasks'; toggle.type = 'button'; toggle.className = 'icon-btn'
  toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'reader-task-list')
  const panel = document.createElement('section'); panel.id = 'reader-task-list'; panel.hidden = true
  panel.setAttribute('aria-label', t('viewer:comfort.taskProgress'))
  const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = t('viewer:comfort.taskRefresh')
  const list = document.createElement('div'); panel.append(refresh, list); shell.append(panel); mount?.append(toggle)
  let tasks = []; let loading = false; let timer; let generation = 0
  const pending = new Map()
  function render() {
    panel.setAttribute('aria-label', t('viewer:comfort.taskProgress'))
    refresh.textContent = t('viewer:comfort.taskRefresh')
    const focusedAction = document.activeElement?.dataset.taskAction
    const label = `${t('viewer:comfort.taskProgress')} (${tasks.filter(task => activeStatuses.has(task.status)).length})`
    toggle.innerHTML = icon('listChecks', 18); toggle.title = label; toggle.setAttribute('aria-label', label)
    list.replaceChildren()
    if (!tasks.length) { const empty = document.createElement('p'); empty.textContent = t('viewer:comfort.tasksEmpty'); list.append(empty) }
    for (const task of tasks) {
      const row = document.createElement('article')
      const title = document.createElement('strong'); title.textContent = `${task.filename} · ${taskKind(task)}`
      const status = document.createElement('p'); status.textContent = taskStatus(task, pending.get(task.id) === 'cancel')
      row.append(title, status)
      if (task.total_pages > 0) {
        const detail = document.createElement('p'); detail.textContent = t('viewer:comfort.taskCount', { done: task.completed_pages.length, total: task.total_pages })
        const progress = document.createElement('progress'); progress.max = task.total_pages; progress.value = task.completed_pages.length; progress.setAttribute('aria-label', detail.textContent)
        row.append(detail, progress)
      }
      const action = (label, handler) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label
        button.dataset.taskAction = `${task.id}:${label}`; button.disabled = pending.has(task.id); button.addEventListener('click', handler); row.append(button)
      }
      action(t('viewer:comfort.taskRead'), () => { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); navigate(`#viewer?id=${encodeURIComponent(task.doc_id)}&page=${task.completed_pages[0] || 1}`) })
      if (activeStatuses.has(task.status)) action(t('viewer:comfort.taskCancel'), () => mutate(task, 'cancel'))
      if (retryKinds.has(task.kind) && ['failed', 'partial_failed', 'cancelled'].includes(task.status)) action(t('viewer:comfort.taskRetry'), () => mutate(task, 'retry'))
      list.append(row)
    }
    if (focusedAction) [...list.querySelectorAll('button')].find(button => button.dataset.taskAction === focusedAction)?.focus({ preventScroll: true })
  }
  async function mutate(task, kind) {
    if (pending.has(task.id)) return
    pending.set(task.id, kind); render()
    try {
      const result = await (kind === 'cancel' ? cancelDocumentTaskAPI : retryDocumentTaskAPI)(task.id)
      tasks = tasks.map(item => item.id === task.id ? { ...item, ...result } : item)
    } catch (error) { toast(error.message, 'error') }
    finally { pending.delete(task.id); render(); void poll() }
  }
  async function poll() {
    clearTimeout(timer)
    if (loading || shell.hidden || document.hidden || !readerFeatureEnabled('taskProgress')) { timer = setTimeout(poll, 5000); return }
    loading = true; const token = generation
    try {
      const result = await getDocumentTasksAPI()
      if (token !== generation) return
      const next = result.tasks || []
      for (const task of next) {
        if (task.status === 'succeeded' && tasks.some(previous => previous.id === task.id && activeStatuses.has(previous.status))) toast(`${task.filename} · ${taskKind(task)} · ${t('viewer:comfort.succeeded')}`, 'success')
      }
      tasks = next; render()
    } catch {
      if (token === generation && !panel.hidden) list.textContent = t('viewer:comfort.taskFailedLoad')
    } finally { loading = false; timer = setTimeout(poll, panel.hidden ? 15000 : 3000) }
  }
  toggle.addEventListener('click', () => { panel.hidden = !panel.hidden; toggle.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) { render(); void poll(); refresh.focus() } })
  refresh.addEventListener('click', poll)
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false'); toggle.focus() } })
  const sync = () => {
    generation++; toggle.hidden = !readerFeatureEnabled('taskProgress')
    if (toggle.hidden) { panel.hidden = true; toggle.setAttribute('aria-expanded', 'false') }
    else void poll()
  }
  // Clear previous-account results whenever the authenticated shell is hidden.
  new MutationObserver(() => { if (shell.hidden) { generation++; tasks = []; panel.hidden = true; render() } else void poll() }).observe(shell, { attributes: true, attributeFilter: ['hidden'] })
  document.addEventListener('easypaper:locale-changed', render)
  onReaderPreferences(sync); render(); sync()
}
