const ACTIVE_TASK_STATUSES = new Set(['queued', 'running', 'retry_wait'])
const RETRYABLE_TASK_STATUSES = new Set(['partial_failed', 'failed', 'cancelled'])

export function isTranslationTaskRunning(job = {}) {
  return ['running', 'pending'].includes(job.status)
    || ACTIVE_TASK_STATUSES.has(job.task_status)
}

export function canRetryTranslationTask(job = {}) {
  return RETRYABLE_TASK_STATUSES.has(job.task_status)
    || !['completed', 'succeeded'].includes(job.status)
}

export function shouldRetryFailedTranslationTask(taskId, taskStatus) {
  return Boolean(taskId && RETRYABLE_TASK_STATUSES.has(taskStatus))
}
