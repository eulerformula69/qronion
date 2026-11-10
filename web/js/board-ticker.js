(function () {
    var tickerMessages = [];
    var systemMessages = [];
    var expiryTimer = null;
    var countdownTimer = null;
    var resizeTimer = null;
    var resizeListenerAttached = false;

    function ensureTicker() {
        var ticker = document.getElementById("board-ticker");
        var track;

        if (ticker) return ticker;

        ticker = document.createElement("div");
        ticker.id = "board-ticker";
        ticker.className = "board-ticker";
        ticker.hidden = true;

        track = document.createElement("div");
        track.className = "board-ticker__track";

        ticker.appendChild(track);
        document.body.appendChild(ticker);

        return ticker;
    }

    function createTextItem(message, isSegmentEnd, hidden) {
        var item = document.createElement("span");
        item.className = "board-ticker__text"
            + (message.system ? " board-ticker__text--system" : "")
            + (isSegmentEnd ? " board-ticker__text--segment-end" : "");
        item.textContent = message.text;
        if (message.system && message.expiresAt) {
            var countdown = document.createElement("span");
            countdown.className = "board-ticker__countdown";
            countdown.setAttribute("data-expires-at", String(message.expiresAt));
            item.appendChild(countdown);
        }
        if (hidden) item.setAttribute("aria-hidden", "true");
        return item;
    }

    function parseTickerMessages(value) {
        return String(value || "")
            .split(/\s+\|\s+|\r?\n/)
            .map(function (line) {
                return line.trim();
            })
            .filter(Boolean);
    }

    function appendMessageSet(track, messages, hidden) {
        var i;

        for (i = 0; i < messages.length; i++) {
            track.appendChild(createTextItem(messages[i], i === messages.length - 1, hidden));
        }
    }

    function formatRemainingTime(totalSeconds) {
        var seconds = Math.max(0, Math.ceil(totalSeconds));
        var minutes = Math.floor(seconds / 60);
        var remainder = seconds % 60;
        return (minutes < 10 ? "0" : "") + minutes
            + ":" + (remainder < 10 ? "0" : "") + remainder;
    }

    function updateSystemCountdowns() {
        var countdowns = document.querySelectorAll(".board-ticker__countdown");
        var now = Date.now();
        for (var i = 0; i < countdowns.length; i++) {
            var expiresAt = Number(countdowns[i].getAttribute("data-expires-at"));
            countdowns[i].textContent = " · ещё " + formatRemainingTime((expiresAt - now) / 1000);
        }
    }

    function renderTickerMessages() {
        var now = Date.now();
        systemMessages = systemMessages.filter(function (item) {
            return !item.expiresAt || item.expiresAt > now;
        });
        if (expiryTimer) clearTimeout(expiryTimer);
        var nextExpiries = systemMessages.map(function (item) { return item.expiresAt; })
            .filter(function (value) { return value && value > now; });
        if (nextExpiries.length) {
            expiryTimer = setTimeout(
                renderTickerMessages,
                Math.max(0, Math.min.apply(null, nextExpiries) - now) + 50
            );
        }
        var messages = tickerMessages.map(function (text) {
            return {text: text, system: false};
        }).concat(systemMessages.map(function (item) {
            return {text: item.text, system: true, expiresAt: item.expiresAt};
        }));
        var ticker = ensureTicker();
        var track = ticker.getElementsByClassName("board-ticker__track")[0];
        var tickerWidth;
        var setWidth;
        var repeatCount;
        var distance;
        var i;

        ticker.hidden = !messages.length;
        document.body.classList.toggle("has-board-ticker", Boolean(messages.length));

        track.innerHTML = "";

        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        if (!messages.length) return;

        appendMessageSet(track, messages, false);
        tickerWidth = ticker.clientWidth || window.innerWidth || 1920;
        setWidth = track.scrollWidth || tickerWidth;
        repeatCount = Math.max(2, Math.ceil(tickerWidth / setWidth) + 2);
        distance = setWidth * repeatCount;

        track.innerHTML = "";
        for (i = 0; i < repeatCount * 2; i++) {
            appendMessageSet(track, messages, i >= repeatCount);
        }

        track.style.setProperty("--board-ticker-distance", distance + "px");
        track.style.setProperty("--board-ticker-duration", Math.max(18, Math.round(distance / 80)) + "s");
        updateSystemCountdowns();
        if (systemMessages.length) {
            countdownTimer = setInterval(updateSystemCountdowns, 1000);
        }
    }

    function scheduleRender() {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderTickerMessages, 100);
    }

    window.setBoardTickerText = function (value) {
        tickerMessages = parseTickerMessages(value);
        renderTickerMessages();

        if (!resizeListenerAttached) {
            window.addEventListener("resize", scheduleRender);
            resizeListenerAttached = true;
        }
    };

    window.setBoardSystemMessages = function (items) {
        if (expiryTimer) clearTimeout(expiryTimer);
        systemMessages = (Array.isArray(items) ? items : []).map(function (item) {
            return {
                text: String(item.message || "").trim(),
                expiresAt: item.expires_at ? new Date(item.expires_at).getTime() : null
            };
        }).filter(function (item) { return item.text; });
        renderTickerMessages();
    };
})();
