export function classificationModalMarkup() {
  return `<div class="custom-confirm-modal classification-confirmation-dialog" role="document">
    <div class="custom-confirm-modal-header"><span id="classification-confirmation-title" class="custom-confirm-modal-title"></span></div>
    <div class="custom-confirm-modal-body">
      <p class="classification-status" role="status" aria-live="polite"></p>
      <p class="classification-reason" id="classification-confirmation-reason"></p>
      <div class="classification-options document-type-options" role="radiogroup" aria-describedby="classification-confirmation-reason"></div>
    </div>
    <div class="custom-confirm-modal-footer"><button type="button" class="custom-confirm-btn confirm-btn primary-btn" disabled></button></div>
  </div>`
}

export function recommendedClassification(payload) {
  const value = payload?.recommendation || payload?.current
  if (!value?.document_mode || !value?.document_type) return null
  return { document_mode: value.document_mode, document_type: value.document_type }
}
