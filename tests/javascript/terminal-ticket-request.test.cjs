const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync('queue/js/terminal-ticket-request.js', 'utf8');

function browser(storage, fetch) {
    const context = vm.createContext({
        crypto: webcrypto, AbortController, setTimeout, clearTimeout,
        CONFIG: { API_URL: '/api' }, fetch,
        localStorage: {
            getItem: key => storage.get(key) || null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: key => storage.delete(key)
        }
    });
    vm.runInContext(source, context);
    return context;
}
const ok = () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) });

test('network retry keeps the ID, next visitor gets a new ID', async () => {
    const requests = [];
    const storage = new Map();
    const page = browser(storage, async (url, options) => {
        requests.push(JSON.parse(options.body));
        if (requests.length === 1) throw new Error('response lost');
        return ok();
    });
    await page.submitTicketRequest(1, null, 'Service', 'session');
    assert.equal(requests[0].request_id, requests[1].request_id);
    assert.equal(storage.size, 0);
    await page.submitTicketRequest(1, null, 'Service', 'session');
    assert.notEqual(requests[1].request_id, requests[2].request_id);
});

test('reload preserves uncertain request and blocks another service', async () => {
    const storage = new Map();
    const failed = browser(storage, async () => { throw new Error('offline'); });
    await assert.rejects(failed.submitTicketRequest(1, null, 'Service', 'session'));
    const original = JSON.parse(storage.get('pending-ticket-creation'));
    let sent;
    const reloaded = browser(storage, async (url, options) => {
        sent = JSON.parse(options.body);
        return ok();
    });
    await assert.rejects(reloaded.submitTicketRequest(2, null, 'Other', 'session'));
    assert.equal(sent, undefined);
    await reloaded.submitTicketRequest(1, null, 'Service', 'new-session');
    assert.equal(sent.request_id, original.request_id);
    assert.equal(storage.size, 0);
});
