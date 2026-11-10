/* board-lite.js — ультра-легковесное табло для старых ТВ (Chromium 79 / WebOS).
   Видео выводит media-lite.js на lite2-страницах. Здесь только табло: ожидающие + вызванные.
   Без async/await, стрелок-функций, optional chaining, replaceAll, Set/Map. */

(function () {
    var CALLED_PAGE_SIZE = (window.BOARD_CONFIG && window.BOARD_CONFIG.calledPageSize) || 7;
    var WAITING_PAGE_SIZE = (window.BOARD_CONFIG && window.BOARD_CONFIG.waitingPageSize) || 7;
    var PAGE_INTERVAL_MS = (window.BOARD_CONFIG && window.BOARD_CONFIG.pageIntervalMs) || 5000;
    var SHOW_LABELS = !window.BOARD_CONFIG || window.BOARD_CONFIG.showLabels !== false;
    var CALL_AUDIO_ENABLED = !window.BOARD_CONFIG || window.BOARD_CONFIG.callAudioEnabled !== false;
    var RECONNECT_MS = 3000;
    var DUPLICATE_CALL_MS = 5000;
    var CLEAN_PROCESSED_MS = 5 * 60 * 1000;

    var ws = null;
    var previousCalledTickets = [];
    var latestWaitingTickets = [];
    var processedIds = {};
    var highlightedIds = {};

    var calledCurrentPage = 0;
    var waitingCurrentPage = 0;
    var calledPages = [];
    var waitingPages = [];
    var pageTimer = null;

    function byId(id) {
        return document.getElementById(id);
    }

    function setStatus(text) {
        var el = byId("ws-status");
        if (el) el.innerHTML = text;
    }

    function toStr(value) {
        if (value === null || typeof value === "undefined") return "";
        return String(value);
    }

    function escapeHtml(value) {
        return toStr(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function getTicketId(ticket) {
        if (!ticket) return "";
        return toStr(ticket.id || ticket.ticket_id || ticket.ticket_number || ticket.number);
    }

    function getTicketNumber(ticket) {
        if (!ticket) return "";
        return toStr(ticket.number || ticket.ticket_number || "");
    }

    function getWindowName(ticket) {
        if (!ticket) return "";
        return toStr(ticket.window_name || ticket.window || ticket.window_number || "");
    }

    function normalizeTicket(ticket) {
        if (!ticket) ticket = {};

        var number = getTicketNumber(ticket);
        var windowName = getWindowName(ticket);
        var id = getTicketId(ticket);

        if (!id) id = number;

        return {
            id: id,
            ticket_id: ticket.ticket_id || id,
            number: number,
            ticket_number: ticket.ticket_number || number,
            window_name: windowName,
            status: ticket.status || "",
            display_text: ticket.display_text || "",
            tts_text: ticket.tts_text || "",
            called_at: ticket.called_at || "",
            last_recalled_at: ticket.last_recalled_at || ""
        };
    }

    function findTicketByNumber(number) {
        var i;
        var n = toStr(number);

        for (i = 0; i < previousCalledTickets.length; i++) {
            if (
                getTicketNumber(previousCalledTickets[i]) === n ||
                toStr(previousCalledTickets[i].ticket_number) === n
            ) {
                return previousCalledTickets[i];
            }
        }

        return null;
    }

    var queueOffsetSeconds = null;

    function updateClock() {
        var el = byId("clock-container");
        var now;
        var dateString;
        var timeString;

        if (!el) return;

        now = new Date();

        try {
            if (typeof Intl === "undefined" || !Intl.DateTimeFormat) throw new Error("Intl unavailable");
            dateString = now.toLocaleDateString("ru-RU", {
                timeZone: CONFIG.TIME_ZONE,
                weekday: "long",
                year: "numeric",
                month: "long",
                day: "numeric"
            });

            timeString = now.toLocaleTimeString("ru-RU", {
                timeZone: CONFIG.TIME_ZONE,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit"
            });

            dateString = dateString.charAt(0).toUpperCase() + dateString.slice(1);
            el.innerHTML = escapeHtml(dateString + " " + timeString);
        } catch (e) {
            if (queueOffsetSeconds !== null) {
                var local = new Date(now.getTime() + queueOffsetSeconds * 1000);
                el.textContent = local.toISOString().slice(0, 19).replace("T", " ");
            }
        }
    }

    function updateTitle() {
        var title = byId("title");
        if (!title) return;
        title.innerHTML = "Табло очереди Приемной комиссии";
    }

    function loadBoardSettings() {
        if (!window.fetch || !window.setBoardTickerText) return;

        fetch(CONFIG.API_URL + "/settings/public")
            .then(function (response) {
                if (!response.ok) return null;
                return response.json();
            })
            .then(function (settings) {
                if (!settings) return;
                window.setBoardTickerText(settings.board_ticker_text || "");
            })
            .catch(function () {});
    }

    function buildPages(tickets, pageSize) {
        var result = [];
        var i;

        if (!tickets || !tickets.length) return result;

        for (i = 0; i < tickets.length; i += pageSize) {
            result.push(tickets.slice(i, i + pageSize));
        }

        return result;
    }

    function renderPageDots(containerId, totalPages, activePage) {
        return;
    }

    function updatePageIndicators() {
        var calledIndicator = byId("called-page-indicator");
        var waitingIndicator = byId("waiting-page-indicator");

        if (calledIndicator) {
            calledIndicator.innerHTML = calledPages.length > 1
                ? (calledCurrentPage + 1) + "/" + calledPages.length
                : "";
        }

        if (waitingIndicator) {
            waitingIndicator.innerHTML = waitingPages.length > 1
                ? (waitingCurrentPage + 1) + "/" + waitingPages.length
                : "";
        }

    }

    function renderCalledPage() {
        var board = byId("board");
        var html = "";
        var currentTickets;
        var i;
        var t;
        var id;
        var number;
        var windowName;

        if (!board) return;

        currentTickets = calledPages[calledCurrentPage] || [];

        if (!currentTickets.length) {
            board.innerHTML = "";
            return;
        }

        for (i = 0; i < currentTickets.length; i++) {
            t = normalizeTicket(currentTickets[i]);
            id = getTicketId(t);
            number = getTicketNumber(t);
            windowName = getWindowName(t);

            var ticketContent = SHOW_LABELS
                ? '<span>БИЛЕТ</span><span>' + escapeHtml(number) + '</span>'
                : '<span>' + escapeHtml(number) + '</span>';
            var windowContent = SHOW_LABELS
                ? '<span>ОПЕРАТОР</span><span>' + escapeHtml(windowName) + '</span>'
                : '<span>' + escapeHtml(windowName) + '</span>';

            html += ""
                + '<div class="card' + (highlightedIds[id] ? ' calling' : '') + '" data-ticket-id="' + escapeHtml(id) + '">'
                + '  <div class="line">'
                + '    <div class="ticket">' + ticketContent + '</div>'
                + '    <div class="arrow">→</div>'
                + '    <div class="window">' + windowContent + '</div>'
                + '  </div>'
                + '</div>';
        }

        board.innerHTML = html;
    }

    function renderWaitingPage() {
        var waitingBoard = byId("waiting-board");
        var html = "";
        var currentTickets;
        var i;
        var t;
        var number;
        var isDeferred;
        var deferredNote;

        if (!waitingBoard) return;

        currentTickets = waitingPages[waitingCurrentPage] || [];

        if (!currentTickets.length) {
            waitingBoard.innerHTML = "";
            return;
        }

        for (i = 0; i < currentTickets.length; i++) {
            t = normalizeTicket(currentTickets[i]);
            number = getTicketNumber(t);
            isDeferred = t.status === "deferred";
            deferredNote = isDeferred
                ? '  <div class="waiting-deferred-note">Отложен оператором' + (t.window_name ? ' · ' + escapeHtml(t.window_name) : '') + '</div>'
                : '';

            html += ""
                + '<div class="waiting-card' + (isDeferred ? ' waiting-card-deferred' : '') + '">'
                + '  <div class="line waiting-line">'
                + '    <span class="ticket">' + escapeHtml(number) + '</span>'
                + '  </div>'
                + deferredNote
                + '</div>';
        }

        waitingBoard.innerHTML = html;
    }

    function renderPage() {
        updateTitle();
        renderCalledPage();
        renderWaitingPage();
        updatePageIndicators();
    }

    function advancePages() {
        if (calledPages.length > 1) {
            calledCurrentPage = calledCurrentPage + 1;
            if (calledCurrentPage >= calledPages.length) calledCurrentPage = 0;
        }

        if (waitingPages.length > 1) {
            waitingCurrentPage = waitingCurrentPage + 1;
            if (waitingCurrentPage >= waitingPages.length) waitingCurrentPage = 0;
        }
    }

    function startPageTimer() {
        if (pageTimer) {
            clearInterval(pageTimer);
            pageTimer = null;
        }

        if (calledPages.length > 1 || waitingPages.length > 1) {
            pageTimer = setInterval(function () {
                advancePages();
                renderPage();
            }, PAGE_INTERVAL_MS);
        }
    }

    function renderBoard(calledTickets, waitingTickets) {
        calledPages = buildPages(calledTickets || [], CALLED_PAGE_SIZE);
        waitingPages = buildPages(waitingTickets || [], WAITING_PAGE_SIZE);

        if (calledCurrentPage >= calledPages.length) calledCurrentPage = 0;
        if (waitingCurrentPage >= waitingPages.length) waitingCurrentPage = 0;

        renderPage();
        startPageTimer();
    }

    function announceTicket(ticket) {
        var normalized = normalizeTicket(ticket);
        var id = getTicketId(normalized);
        var i;
        var found = false;

        if (!id) return;

        if (processedIds[id] && new Date().getTime() - processedIds[id] < DUPLICATE_CALL_MS) return;

        processedIds[id] = new Date().getTime();
        highlightedIds[id] = new Date().getTime();

        for (i = 0; i < previousCalledTickets.length; i++) {
            if (getTicketId(previousCalledTickets[i]) === id) {
                found = true;
                break;
            }
        }

        if (!found) {
            previousCalledTickets.unshift(normalized);
            calledCurrentPage = 0;
            renderBoard(previousCalledTickets, latestWaitingTickets);
        } else {
            renderPage();
        }

        if (CALL_AUDIO_ENABLED && typeof window.speakTicketLite === "function") {
            window.speakTicketLite(normalized, function (ticketId, isActive) {
                if (isActive) {
                    highlightedIds[ticketId] = new Date().getTime();
                } else {
                    delete highlightedIds[ticketId];
                }

                renderPage();
            });
        }
    }

    function mergeIncomingTickets(tickets) {
        var arr = [];
        var i;

        if (!tickets || !tickets.length) return arr;

        for (i = 0; i < tickets.length; i++) {
            arr.push(normalizeTicket(tickets[i]));
        }

        return arr;
    }

    function normalizeBoardState(data) {
        if (data && typeof data.utc_offset_seconds === "number") queueOffsetSeconds = data.utc_offset_seconds;
        if (data && (data.type === "board_state" || Object.prototype.toString.call(data.called) === "[object Array]" || Object.prototype.toString.call(data.waiting) === "[object Array]")) {
            if (typeof window.setBoardSystemMessages === "function") {
                window.setBoardSystemMessages(Object.prototype.toString.call(data.cancelled) === "[object Array]" ? data.cancelled : []);
            }
            return {
                called: Object.prototype.toString.call(data.called) === "[object Array]" ? data.called : (Object.prototype.toString.call(data.tickets) === "[object Array]" ? data.tickets : []),
                waiting: Object.prototype.toString.call(data.waiting) === "[object Array]" ? data.waiting : []
            };
        }

        if (Object.prototype.toString.call(data) === "[object Array]") {
            return { called: data, waiting: latestWaitingTickets };
        }

        if (data && Object.prototype.toString.call(data.tickets) === "[object Array]") {
            return { called: data.tickets, waiting: latestWaitingTickets };
        }

        return null;
    }

    function handleBoardState(boardState) {
        var called = mergeIncomingTickets(boardState.called || []);
        var waiting = mergeIncomingTickets(boardState.waiting || []);
        previousCalledTickets = called;
        latestWaitingTickets = waiting;
        renderBoard(previousCalledTickets, latestWaitingTickets);
    }

    function handleRecall(data) {
        var ticket;
        var existing;
        var realId;
        var srcTicket;

        if (data.type === "ticket_called" && data.ticket) {
            srcTicket = data.ticket;
        } else {
            srcTicket = data;
        }

        realId = srcTicket.ticket_id || srcTicket.id || data.ticket_id || data.id || data.call_id || "";

        if (!realId) {
            existing = findTicketByNumber(srcTicket.ticket_number || srcTicket.number || data.ticket_number || data.number);
            if (existing) realId = getTicketId(existing);
        }

        ticket = normalizeTicket({
            id: realId || srcTicket.ticket_number || srcTicket.number || data.ticket_number || data.number,
            ticket_id: srcTicket.ticket_id || data.ticket_id || realId,
            number: srcTicket.ticket_number || srcTicket.number || data.ticket_number || data.number,
            ticket_number: srcTicket.ticket_number || srcTicket.number || data.ticket_number || data.number,
            window_name: srcTicket.window_name || data.window_name || srcTicket.window || data.window || data.window_number,
            display_text: srcTicket.display_text || data.display_text || "",
            tts_text: data.tts_text || srcTicket.tts_text || ""
        });

        announceTicket(ticket);
    }

    function handleMessage(event) {
        var data;
        var boardState;

        try {
            data = JSON.parse(event.data);
        } catch (e) {
            return;
        }

        if (data.type === "playlist_updated") {
            try {
                if (window.initPlaylist) window.initPlaylist(true);
            } catch (e2) {}
            return;
        }

        if (data.type === "settings_updated") {
            loadBoardSettings();
            return;
        }

        boardState = normalizeBoardState(data);
        if (boardState) {
            handleBoardState(boardState);
            return;
        }

        if (
            data.type === "recall_ticket" ||
            data.type === "call_ticket" ||
            data.type === "ticket_called" ||
            data.ticket_number ||
            data.number
        ) {
            handleRecall(data);
            return;
        }
    }

    function connectWS() {
        try {
            ws = new WebSocket(CONFIG.WS_BOARD_URL);
            window.watchBoardConnection(ws);
        } catch (e) {
            setStatus("WS: error");
            setTimeout(connectWS, RECONNECT_MS);
            return;
        }

        ws.onopen = function () {
            setStatus("WS: connected");
        };

        ws.onclose = function () {
            setStatus("WS: reconnecting...");
            setTimeout(connectWS, RECONNECT_MS);
        };

        ws.onerror = function () {
            setStatus("WS: error");
        };

        ws.onmessage = handleMessage;
    }

    function init() {
        updateClock();
        setInterval(updateClock, 1000);

        renderBoard([], []);
        loadBoardSettings();
        connectWS();

        setInterval(function () {
            var now = new Date().getTime();
            var key;
            var changed = false;

            for (key in processedIds) {
                if (processedIds.hasOwnProperty(key)) {
                    if (now - processedIds[key] > CLEAN_PROCESSED_MS) {
                        delete processedIds[key];
                    }
                }
            }

            for (key in highlightedIds) {
                if (highlightedIds.hasOwnProperty(key)) {
                    if (now - highlightedIds[key] > 8000) {
                        delete highlightedIds[key];
                        changed = true;
                    }
                }
            }

            if (changed) renderPage();
        }, 1000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
