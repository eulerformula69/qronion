/* Recover missed board updates on both modern browsers and older TV WebViews. */
(function () {
    window.watchBoardConnection = function (socket) {
        var interval = null;
        var deadline = null;

        function stop() {
            clearInterval(interval);
            clearTimeout(deadline);
            interval = null;
            deadline = null;
        }

        function requestState() {
            if (socket.readyState !== 1 || deadline !== null) return;
            deadline = setTimeout(function () {
                stop();
                socket.close();
            }, 10000);
            try {
                socket.send(JSON.stringify({ type: "board_sync" }));
            } catch (error) {
                stop();
                socket.close();
            }
        }

        socket.addEventListener("open", function () {
            stop();
            requestState();
            interval = setInterval(requestState, 15000);
        });
        socket.addEventListener("message", function (event) {
            var data;
            try {
                data = JSON.parse(event.data);
            } catch (error) {
                return;
            }
            if (data && data.type === "board_state") {
                clearTimeout(deadline);
                deadline = null;
            }
        });
        socket.addEventListener("close", stop);
    };
})();
