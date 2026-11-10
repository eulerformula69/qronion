/* tts-lite.js — максимально простой TTS для LG/WebOS.
   Без async/await, стрелок, optional chaining, replaceAll. */
(function () {
    var queue = [];
    var playing = false;
    var lastActivityAt = 0;
    var SAFETY_TIMEOUT_MS = 15000;
    var PAUSE_MS = 800;

    function emit(name) {
        try {
            if (window.CustomEvent) {
                window.dispatchEvent(new CustomEvent(name));
            }
        } catch (e) {}
    }

    function getTicketText(ticket) {
        if (ticket && ticket.tts_text) return ticket.tts_text;

        var number = "";
        var windowName = "";

        if (ticket) {
            number = ticket.number || ticket.ticket_number || "";
            windowName = ticket.window_name || ticket.window || ticket.window_number || "";
        }

        return "Талон " + number + ". Подойдите к окну " + windowName + ".";
    }

    function speakTicketLite(ticket, onStateChange) {
        lastActivityAt = new Date().getTime();
        queue.push({
            ticket: ticket,
            onStateChange: onStateChange
        });

        if (!playing) processQueue();
    }

    function processQueue() {
        var item;
        var ticket;
        var ticketId;
        var text;
        var url;
        var AudioContextClass;
        var context;
        var source = null;
        var request;
        var doneCalled = false;
        var safetyTimer;
        var started = false;

        if (!queue.length) {
            playing = false;
            return;
        }

        playing = true;
        item = queue.shift();
        ticket = item.ticket || {};
        ticketId = String(ticket.id || ticket.ticket_id || ticket.ticket_number || ticket.number || "");

        text = getTicketText(ticket);
        url = "/tts/audio?text=" + encodeURIComponent(text) + "&t=" + String(new Date().getTime());

        function finish() {
            if (doneCalled) return;
            doneCalled = true;
            lastActivityAt = new Date().getTime();

            try { clearTimeout(safetyTimer); } catch (e) {}
            try { if (source) source.stop(0); } catch (e) {}
            try { if (context && context.close) context.close(); } catch (e) {}

            if (started && item.onStateChange) {
                try { item.onStateChange(ticketId, false); } catch (e) {}
            }

            if (started) emit("ticket-speech-end");

            setTimeout(function () {
                processQueue();
            }, PAUSE_MS);
        }

        safetyTimer = setTimeout(finish, SAFETY_TIMEOUT_MS);

        AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            finish();
            return;
        }

        try {
            context = new AudioContextClass();
            request = new XMLHttpRequest();
            request.open("GET", url, true);
            request.responseType = "arraybuffer";

            request.onload = function () {
                if (request.status < 200 || request.status >= 300 || !request.response) {
                    finish();
                    return;
                }

                context.decodeAudioData(
                    request.response,
                    function (buffer) {
                        if (doneCalled) return;

                        try {
                            source = context.createBufferSource();
                            source.buffer = buffer;
                            source.connect(context.destination);
                            source.onended = finish;
                            started = true;

                            if (item.onStateChange) {
                                try { item.onStateChange(ticketId, true); } catch (e) {}
                            }

                            emit("ticket-speech-start");
                            source.start(0);
                        } catch (e) {
                            finish();
                        }
                    },
                    finish
                );
            };

            request.onerror = finish;
            request.onabort = finish;
            request.send();
        } catch (e) {
            finish();
        }
    }

    window.speakTicketLite = speakTicketLite;
    window.BoardTTSLite = {
        isBusy: function () {
            return playing || queue.length > 0;
        },
        getLastActivityAt: function () {
            return lastActivityAt;
        }
    };
})();
