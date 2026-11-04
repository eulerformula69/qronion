/* Медиаплеер для старых LG webOS без современного синтаксиса JavaScript. */
(function () {
    var currentPlaylist = [];
    var playlistIndex = 0;
    var VIDEO_AUDIO_ENABLED = !window.BOARD_CONFIG || window.BOARD_CONFIG.videoAudioEnabled !== false;

    function getFileName(path) {
        try {
            return decodeURIComponent(String(path).split("/").pop().split("?")[0]);
        } catch (e) {
            return String(path);
        }
    }

    function playVideo(video) {
        var promise;

        try {
            video.muted = !VIDEO_AUDIO_ENABLED;
            video.volume = VIDEO_AUDIO_ENABLED ? 1.0 : 0;
            promise = video.play();
            if (promise && promise.catch) promise.catch(function () {});
        } catch (e) {}
    }

    function loadPlaylist(isUpdate) {
        var video = document.getElementById("media-video");
        var request;

        if (!video) return;

        request = new XMLHttpRequest();
        request.open("GET", "/queue/media/playlist.json?t=" + new Date().getTime(), true);
        request.onreadystatechange = function () {
            var data;
            var newPlaylist;
            var currentFileName;
            var found = false;
            var i;

            if (request.readyState !== 4 || request.status < 200 || request.status >= 300) return;

            try {
                data = JSON.parse(request.responseText);
            } catch (e) {
                return;
            }

            newPlaylist = Object.prototype.toString.call(data) === "[object Array]" ? data : [];
            currentPlaylist = newPlaylist;

            if (!currentPlaylist.length) {
                video.removeAttribute("src");
                video.load();
                return;
            }

            if (video.currentSrc || video.src) {
                currentFileName = getFileName(video.currentSrc || video.src);
                for (i = 0; i < currentPlaylist.length; i++) {
                    if (getFileName(currentPlaylist[i]) === currentFileName) {
                        playlistIndex = i;
                        found = true;
                        break;
                    }
                }
            }

            if (!found) {
                if (playlistIndex >= currentPlaylist.length) playlistIndex = 0;
                video.src = currentPlaylist[playlistIndex];
                playVideo(video);
            }
        };
        request.send();
    }

    function init() {
        var video = document.getElementById("media-video");
        if (!video) return;

        video.muted = !VIDEO_AUDIO_ENABLED;
        video.volume = VIDEO_AUDIO_ENABLED ? 1.0 : 0;

        video.addEventListener("ended", function () {
            if (!currentPlaylist.length) return;
            playlistIndex = (playlistIndex + 1) % currentPlaylist.length;

            video.src = currentPlaylist[playlistIndex];
            playVideo(video);
        });

        window.addEventListener("ticket-speech-start", function () {
            if (VIDEO_AUDIO_ENABLED) video.volume = 0.2;
        });

        window.addEventListener("ticket-speech-end", function () {
            setTimeout(function () {
                video.volume = VIDEO_AUDIO_ENABLED ? 1.0 : 0;
            }, 6000);
        });

        window.addEventListener("playlist-updated", function () {
            loadPlaylist(true);
        });

        window.initPlaylist = loadPlaylist;
        loadPlaylist(false);

    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
