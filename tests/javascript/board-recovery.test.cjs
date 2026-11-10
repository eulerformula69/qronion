const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(engine) {
    let now = 0, next = 0, speechCount = 0;
    const timers = new Map(), sockets = [], listeners = {};
    const elements = { board: { innerHTML: '' }, 'waiting-board': { innerHTML: '' }, 'ws-status': {} };
    function schedule(fn, delay, repeat) {
        const id = ++next;
        timers.set(id, { fn, due: now + delay, delay, repeat });
        return id;
    }
    class Socket {
        constructor() { this.readyState = 0; this.events = {}; this.sent = []; sockets.push(this); }
        addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
        emit(type, value = {}) {
            for (const fn of this.events[type] || []) fn(value);
            if (this['on' + type]) this['on' + type](value);
        }
        open() { this.readyState = 1; this.emit('open'); }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.readyState = 3; this.emit('close'); }
        state(called, waiting = []) {
            this.emit('message', { data: JSON.stringify({ type: 'board_state', called, waiting, cancelled: [] }) });
        }
    }
    const context = vm.createContext({
        console, fetch: async () => ({ ok: false }), WebSocket: Socket, CONFIG: { WS_BOARD_URL: '/ws/board' },
        document: { readyState: 'loading', addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); }, getElementById: id => elements[id] || null },
        setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
        speakTicket: () => speechCount++, speakTicketLite: () => speechCount++
    });
    context.window = context;
    vm.runInContext(fs.readFileSync('web/js/board-recovery.js', 'utf8'), context);
    vm.runInContext(fs.readFileSync('web/js/' + engine, 'utf8'), context);
    if (engine === 'board.js') {
        // Observe the render input without depending on card markup.
        vm.runInContext('renderLatestTickets = function () { window.visibleCalled = latestTickets; window.visibleWaiting = latestWaitingTickets; }; connectWS();', context);
    } else {
        for (const fn of listeners.DOMContentLoaded) fn();
    }
    function tick(ms) {
        const target = now + ms;
        while (true) {
            const entry = [...timers].filter(([, t]) => t.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
            if (!entry) break;
            const [id, timer] = entry;
            now = timer.due;
            if (timer.repeat) timer.due += timer.delay; else timers.delete(id);
            timer.fn();
        }
        now = target;
    }
    return { sockets, tick, context, elements, speech: () => speechCount };
}

for (const engine of ['board.js', 'board-lite.js']) {
    test(engine + ': missed update recovers without speech; repeats replace state', () => {
        const page = setup(engine), socket = page.sockets[0];
        socket.open();
        assert.equal(socket.sent[0].type, 'board_sync');
        socket.state([], [{ id: 1, number: 42 }]);
        // A call commits but its event is lost. The next snapshot repairs the screen.
        page.tick(15000);
        assert.equal(socket.sent.length, 2);
        socket.state([{ id: 1, number: 42, window_name: 'A' }]);
        socket.state([{ id: 1, number: 42, window_name: 'A' }]);
        if (engine === 'board.js') {
            assert.equal(page.context.visibleCalled.length, 1);
            assert.equal(page.context.visibleWaiting.length, 0);
        } else {
            assert.match(page.elements.board.innerHTML, /42/);
            assert.equal(page.elements['waiting-board'].innerHTML, '');
        }
        assert.equal(page.speech(), 0);
        socket.state([]);
        if (engine === 'board.js') assert.equal(page.context.visibleCalled.length, 0);
        else assert.equal(page.elements.board.innerHTML, '');
    });

    test(engine + ': no reply triggers reconnect; old timers stop', () => {
        const page = setup(engine), socket = page.sockets[0];
        socket.open();
        socket.state([]);
        page.tick(15000);
        // Unrelated traffic must not hide a missing state response.
        socket.emit('message', { data: JSON.stringify({ type: 'settings_updated' }) });
        page.tick(10000);
        assert.equal(socket.readyState, 3);
        page.tick(3000);
        assert.equal(page.sockets.length, 2);
        const replacement = page.sockets[1];
        replacement.open();
        replacement.state([{ id: 2, number: 99, window_name: 'B' }]);
        page.tick(15000);
        assert.equal(socket.sent.length, 2);
        assert.equal(replacement.sent.length, 2);
    });
}
