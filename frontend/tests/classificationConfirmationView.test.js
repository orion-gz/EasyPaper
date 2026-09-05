import test from 'node:test'
import assert from 'node:assert/strict'
import { classificationModalMarkup, recommendedClassification } from '../src/classificationConfirmationView.js'

test('classification modal exposes accessible status and radio group contracts', () => {
  const html = classificationModalMarkup()
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /role="radiogroup"/)
  assert.match(html, /aria-describedby="classification-confirmation-reason"/)
  assert.match(html, /class="custom-confirm-modal classification-confirmation-dialog"/)
  assert.match(html, /class="classification-options document-type-options"/)
})

test('recommendation falls back to current manual choice', () => {
  assert.deepEqual(recommendedClassification({ current: { document_mode: 'general', document_type: 'manual' } }), { document_mode: 'general', document_type: 'manual' })
  assert.equal(recommendedClassification({}), null)
})
