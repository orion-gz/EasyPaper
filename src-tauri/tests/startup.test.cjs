const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(`${__dirname}/../loading-page/index.html`, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function setup(invoke) {
  const elements = { status: { textContent: 'starting' }, help: { hidden: true } };
  let poll, deadline;
  vm.runInNewContext(script, {
    window: { __TAURI_INTERNALS__: { invoke } },
    document: { getElementById: id => elements[id] },
    setInterval: fn => { poll = fn; return 1; },
    setTimeout: fn => { deadline = fn; return 2; },
    clearInterval() {}, clearTimeout() {},
  });
  return { elements, poll, deadline };
}
test('startup failure is shown even when it predates page initialization', async () => {
  const page = setup(async () => 'backend exited');
  await page.poll();
  assert.equal(page.elements.status.textContent, 'backend exited');
  assert.equal(page.elements.help.hidden, false);
});
test('pending startup keeps the loading message', async () => {
  const page = setup(async () => null);
  await page.poll();
  assert.equal(page.elements.status.textContent, 'starting');
});
test('deadline ends loading when IPC never responds', () => {
  const page = setup(() => new Promise(() => {}));
  page.poll();
  page.deadline();
  assert.equal(page.elements.help.hidden, false);
});
test('deadline ends loading when IPC rejects', async () => {
  const page = setup(async () => { throw new Error('IPC unavailable'); });
  await page.poll();
  page.deadline();
  assert.equal(page.elements.help.hidden, false);
});
