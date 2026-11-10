const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

test("board shows the queue date and clock across midnight", () => {
    const clock = {};
    const document = {
        addEventListener() {},
        getElementById: () => clock,
        querySelector: () => ({ content: "Pacific/Auckland" })
    };
    class FixedDate extends Date {
        constructor() { super("2026-11-09T11:05:00Z"); }
    }
    const window = { location: { origin: "http://localhost" } };
    const context = vm.createContext({ document, window, Date: FixedDate, setInterval() {} });
    for (const file of ["config.js", "board.js"]) {
        vm.runInContext(fs.readFileSync("web/js/" + file, "utf8"), context);
    }
    vm.runInContext("updateClock()", context);
    assert.match(clock.textContent, /10 ноября 2026/);
    assert.match(clock.textContent, /00:05:00/);
});
