/* Select the board engine before loading it. Keep this file compatible with old LG webOS. */
(function () {
    function getScreenName() {
        var query = window.location.search.replace(/^\?/, "").split("&");
        var i;
        var parts;

        for (i = 0; i < query.length; i++) {
            parts = query[i].split("=");
            if (decodeURIComponent(parts[0] || "") === "screen") {
                return decodeURIComponent((parts[1] || "").replace(/\+/g, " "));
            }
        }

        return "default";
    }

    function loadScript(path) {
        document.write('<script src="' + path + '"><\/script>');
    }

    function getBooleanFlag(name, defaultValue) {
        var query = window.location.search.replace(/^\?/, "").split("&");
        var i;
        var parts;
        var key;
        var value;

        for (i = 0; i < query.length; i++) {
            parts = query[i].split("=");
            key = decodeURIComponent(parts[0] || "");

            if (key === name) {
                value = decodeURIComponent((parts[1] || "").replace(/\+/g, " ")).toLowerCase();
                return value !== "0" && value !== "false" && value !== "off" && value !== "no";
            }
        }

        return defaultValue;
    }

    var screen = getScreenName();
    var isMedia = screen === "media";

    if (screen !== "2") {
        document.body.className += " board-styled";
        document.querySelector(".board-section-waiting .board-section-header span").textContent = "Ожидайте вызова";
        document.querySelector(".board-section-called .board-section-header span").textContent = "Подойдите к окну";
    }

    if (isMedia) {
        document.body.setAttribute("data-board-profile", "media");
        document.body.className += " board-media-page";
        window.BOARD_CONFIG = {
            calledPageSize: 5,
            waitingPageSize: 5,
            pageIntervalMs: 5000,
            showLabels: false,
            callAudioEnabled: getBooleanFlag("call_audio", true),
            videoAudioEnabled: getBooleanFlag("video_audio", true)
        };

        loadScript("/queue/js/media-lite.js?v=board-profile-7");
        loadScript("/queue/js/tts-lite.js?v=board-profile-7");
        loadScript("/queue/js/board-ticker.js");
        loadScript("/queue/js/board-lite.js?v=board-profile-7");
        loadScript("/queue/js/board-lite2.js?v=board-profile-2");
        return;
    }

    loadScript("/queue/js/tts.js");
    loadScript("/queue/js/board-ticker.js");
    loadScript("/queue/js/board-profiles.js");
    loadScript("/queue/js/board.js");
})();
