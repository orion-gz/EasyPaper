import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canRetryTranslationTask,
  isTranslationTaskRunning,
  shouldRetryFailedTranslationTask,
} from '../src/translationTaskState.js'

test('partial translation failure is terminal and retryable', () => {
  const job = { status: 'completed_with_errors', task_status: 'partial_failed' }
  assert.equal(isTranslationTaskRunning(job), false)
  assert.equal(canRetryTranslationTask(job), true)
  assert.equal(shouldRetryFailedTranslationTask('task-1', job.task_status), true)
})

test('successful translation is not offered for retry', () => {
  const job = { status: 'completed', task_status: 'succeeded' }
  assert.equal(isTranslationTaskRunning(job), false)
  assert.equal(canRetryTranslationTask(job), false)
  assert.equal(shouldRetryFailedTranslationTask('task-1', job.task_status), false)
})

test('queued and retry-wait tasks remain active', () => {
  assert.equal(isTranslationTaskRunning({ status: 'running', task_status: 'queued' }), true)
  assert.equal(isTranslationTaskRunning({ status: 'running', task_status: 'retry_wait' }), true)
})
