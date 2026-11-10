const WS_PROTOCOL = window.location.protocol === "https:" ? "wss:" : "ws:";

const QUEUE_TIME_ZONE = document.querySelector('meta[name="queue-timezone"]').content;

const CONFIG = {
    TIME_ZONE: QUEUE_TIME_ZONE,
    API_URL: window.location.origin,
    WS_TERMINAL_URL: `${WS_PROTOCOL}//${window.location.host}/ws/terminal`,
    WS_BOARD_URL: `${WS_PROTOCOL}//${window.location.host}/ws/board`,
    NOTICE_DURATION: 7,
    RECONNECT_INTERVAL: 2000,
    OPERATOR_POLL_INTERVAL_MS: 7000,
    GRAFANA_URL: `${window.location.origin}/grafana/d/queue-statistics/queue-statistics`,
    MEDIA_IDLE_DELAY: 15
};
