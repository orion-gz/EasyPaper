import { test, expect } from '@playwright/test'
import { gotoApp, mockBaseRoutes } from './helpers.js'

const doc = {
  id: 'doc-sync', filename: 'sync.pdf', total_pages: 1,
  created_at: '2026-01-01T00:00:00Z', metadata: { title: 'Sync' }, translated_pages: [],
}

function createSyncServer() {
  const resources = Object.fromEntries(['annotations', 'memos'].map(resource => [resource, {
    data: {}, updated_at: null, revision: 0, item_versions: {}, tombstones: {},
  }]))
  const processed = new Map()
  let copySequence = 0

  function find(snapshot, itemId) {
    for (const [pageKey, items] of Object.entries(snapshot.data)) {
      const index = items.findIndex(item => item.id === itemId)
      if (index >= 0) return { pageKey, index, item: items[index] }
    }
    return null
  }

  function remove(snapshot, itemId) {
    const found = find(snapshot, itemId)
    if (!found) return null
    snapshot.data[found.pageKey].splice(found.index, 1)
    if (!snapshot.data[found.pageKey].length) delete snapshot.data[found.pageKey]
    return found
  }

  async function routeHandler(route) {
    const request = route.request()
    const match = new URL(request.url()).pathname.match(/\/api\/library\/doc-sync\/(annotations|memos)$/)
    if (!match) return route.fallback()
    const snapshot = resources[match[1]]
    if (request.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) })
    }
    const payload = request.postDataJSON()
    const results = []
    for (const mutation of payload.mutations) {
      const mutationKey = `${match[1]}:${payload.client_id}:${mutation.mutation_id}`
      if (processed.has(mutationKey)) {
        results.push({ ...processed.get(mutationKey), already_applied: true })
        continue
      }
      const found = find(snapshot, mutation.item_id)
      const tombstone = snapshot.tombstones[mutation.item_id]
      const currentVersion = snapshot.item_versions[mutation.item_id] || tombstone?.version || 0
      const result = { mutation_id: mutation.mutation_id, item_id: mutation.item_id,
        applied: false, already_applied: false, conflict_copy: false,
        delete_conflict_preserved: false }
      if (mutation.operation === 'delete') {
        if (tombstone) result.already_applied = true
        else if (found && mutation.base_version === currentVersion) {
          remove(snapshot, mutation.item_id)
          snapshot.revision += 1
          snapshot.item_versions[mutation.item_id] = snapshot.revision
          snapshot.tombstones[mutation.item_id] = { version: snapshot.revision, page_key: found.pageKey }
          result.applied = true
        } else if (found) result.delete_conflict_preserved = true
      } else if (!found && !tombstone && mutation.base_version === 0) {
        snapshot.revision += 1
        snapshot.data[mutation.page_key] ||= []
        snapshot.data[mutation.page_key].push(mutation.item)
        snapshot.item_versions[mutation.item_id] = snapshot.revision
        result.applied = true
      } else if (found && mutation.base_version === currentVersion) {
        remove(snapshot, mutation.item_id)
        snapshot.revision += 1
        snapshot.data[mutation.page_key] ||= []
        snapshot.data[mutation.page_key].push(mutation.item)
        snapshot.item_versions[mutation.item_id] = snapshot.revision
        result.applied = true
      } else {
        const copyId = `conflict-copy-${++copySequence}`
        snapshot.revision += 1
        snapshot.data[mutation.page_key] ||= []
        snapshot.data[mutation.page_key].push({ ...mutation.item, id: copyId, conflict_of: mutation.item_id })
        snapshot.item_versions[copyId] = snapshot.revision
        Object.assign(result, { conflict_copy: true, conflict_copy_id: copyId })
      }
      processed.set(mutationKey, result)
      results.push(result)
    }
    snapshot.updated_at = new Date().toISOString()
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...snapshot, results }) })
  }
  return { routeHandler }
}

async function installPage(page, server) {
  await mockBaseRoutes(page, { documents: [doc] })
  await page.route('**/api/library/doc-sync/{annotations,memos}', server.routeHandler)
  await gotoApp(page)
}

async function record(page, resource, data) {
  await page.evaluate(({ resource, data }) => {
    const dataKey = `easypaper_${resource}_doc-sync`
    const queueKey = `easypaper_annotation_sync_queue_${resource}_doc-sync`
    const metaKey = `easypaper_annotation_sync_meta_${resource}_doc-sync`
    const before = JSON.parse(localStorage.getItem(dataKey) || '{}')
    const meta = JSON.parse(localStorage.getItem(metaKey) || '{"item_versions":{}}')
    const flatten = value => new Map(Object.entries(value).flatMap(([pageKey, items]) =>
      (items || []).map(item => [item.id, { pageKey, item }])))
    const oldItems = flatten(before)
    const newItems = flatten(data)
    const queue = []
    newItems.forEach(({ pageKey, item }, itemId) => {
      const old = oldItems.get(itemId)
      if (old && JSON.stringify(old.item) === JSON.stringify(item) && old.pageKey === pageKey) return
      queue.push({ mutation_id: crypto.randomUUID(), operation: 'upsert', item_id: itemId,
        page_key: pageKey, base_version: meta.item_versions?.[itemId] || 0, item })
    })
    oldItems.forEach(({ pageKey }, itemId) => {
      if (!newItems.has(itemId)) queue.push({ mutation_id: crypto.randomUUID(), operation: 'delete',
        item_id: itemId, page_key: pageKey, base_version: meta.item_versions?.[itemId] || 0 })
    })
    localStorage.setItem(dataKey, JSON.stringify(data))
    localStorage.setItem(queueKey, JSON.stringify(queue))
  }, { resource, data })
}

async function synchronize(page) {
  await page.locator('.sidebar-nav-item[data-page="dashboard"]').click()
  await page.locator('.sidebar-nav-item[data-page="notes"]').click()
  await expect(page.locator('#page-notes.active')).toBeVisible()
  await expect.poll(() => page.evaluate(() => ({
    annotationsMeta: !!localStorage.getItem('easypaper_annotation_sync_meta_annotations_doc-sync'),
    memosMeta: !!localStorage.getItem('easypaper_annotation_sync_meta_memos_doc-sync'),
    annotationsQueued: !!localStorage.getItem('easypaper_annotation_sync_queue_annotations_doc-sync'),
    memosQueued: !!localStorage.getItem('easypaper_annotation_sync_queue_memos_doc-sync'),
  }))).toEqual({ annotationsMeta: true, memosMeta: true,
    annotationsQueued: false, memosQueued: false })
}

async function localData(page, resource) {
  return page.evaluate(resource => JSON.parse(localStorage.getItem(`easypaper_${resource}_doc-sync`) || '{}'), resource)
}

test('Mac/Windows 컨텍스트가 항목을 병합하고 충돌·삭제를 보존한다', async ({ browser }) => {
  const server = createSyncServer()
  const macContext = await browser.newContext({ userAgent: 'EasyPaper E2E macOS' })
  const windowsContext = await browser.newContext({ userAgent: 'EasyPaper E2E Windows' })
  const mac = await macContext.newPage()
  const windows = await windowsContext.newPage()
  await installPage(mac, server)
  await installPage(windows, server)
  await synchronize(mac)
  await synchronize(windows)

  await record(mac, 'annotations', { page_1: [{ id: 'mac-highlight', type: 'highlight', text: 'Mac' }] })
  await record(windows, 'memos', { page_1: [{ id: 'shared-memo', content: 'Windows memo' }] })
  await synchronize(mac)
  await synchronize(windows)
  await synchronize(mac)
  await synchronize(windows)
  expect((await localData(mac, 'memos')).page_1[0].content).toBe('Windows memo')
  expect((await localData(windows, 'annotations')).page_1[0].text).toBe('Mac')

  await record(mac, 'memos', { page_1: [{ id: 'shared-memo', content: 'Mac edit' }] })
  await record(windows, 'memos', { page_1: [{ id: 'shared-memo', content: 'Windows edit' }] })
  await synchronize(mac)
  await synchronize(windows)
  await synchronize(mac)
  const contents = (await localData(mac, 'memos')).page_1.map(item => item.content).sort()
  expect(contents).toEqual(['Mac edit', 'Windows edit'])

  await record(mac, 'annotations', {})
  await synchronize(mac)
  await synchronize(windows)
  expect(await localData(windows, 'annotations')).toEqual({})

  await macContext.close()
  await windowsContext.close()
})
