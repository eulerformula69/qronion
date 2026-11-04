(function () {
    const BOARD_PROFILES = {
        default: {
            callPopup: false,
            callHighlight: true,
            showLabels: true,
            layout: "default",
            calledPageSize: 10,
            waitingPageSize: 5,
            pageIntervalMs: 5000,
        },
        "2": {
            callPopup: true,
            callHighlight: false,
            showLabels: true,
            layout: "default",
            calledPageSize: 10,
            waitingPageSize: 5,
            pageIntervalMs: 5000,
        },
        media: {
            callPopup: false,
            callHighlight: true,
            showLabels: false,
            layout: "media",
            calledPageSize: 5,
            waitingPageSize: 5,
            pageIntervalMs: 5000,
        },
    };

    const POPUP_DURATION_MS = 5500;
    let activeProfile = null;
    let popupTimer = null;

    function normalizeBoardProfile(value) {
        if (!value || value === "1" || !BOARD_PROFILES[value]) {
            return "default";
        }

        return value;
    }

    function getCurrentProfile() {
        if (activeProfile) return activeProfile;

        const screen = new URLSearchParams(window.location.search).get("screen");
        const profileName = normalizeBoardProfile(screen);
        activeProfile = {
            name: profileName,
            ...BOARD_PROFILES[profileName],
        };

        return activeProfile;
    }

    function applyCurrentProfile() {
        const profile = getCurrentProfile();

        document.body.dataset.boardProfile = profile.name;
        document.body.classList.toggle("board-media-page", profile.layout === "media");
        window.BOARD_CONFIG = {
            calledPageSize: profile.calledPageSize,
            waitingPageSize: profile.waitingPageSize,
            pageIntervalMs: profile.pageIntervalMs,
        };
        window.BOARD_DISABLE_FORCED_RELOAD = true;
    }

    function setOptionalText(element, value) {
        if (!element) return;

        const text = String(value ?? "").trim();
        element.textContent = text;
        element.hidden = !text;
    }

    function ensureCallPopup() {
        let popup = document.getElementById("board-call-popup");
        if (popup) return popup;

        popup = document.createElement("div");
        popup.id = "board-call-popup";
        popup.className = "board-call-popup";
        popup.hidden = true;

        const content = document.createElement("div");
        content.className = "board-call-popup__content";

        const label = document.createElement("div");
        label.className = "board-call-popup__label";
        label.textContent = "Вызван талон";

        const number = document.createElement("div");
        number.id = "board-call-popup-number";
        number.className = "board-call-popup__number";

        const details = document.createElement("div");
        details.className = "board-call-popup__details";

        const service = document.createElement("div");
        service.id = "board-call-popup-service";
        service.className = "board-call-popup__detail board-call-popup__service";

        const operator = document.createElement("div");
        operator.id = "board-call-popup-operator";
        operator.className = "board-call-popup__detail board-call-popup__operator";

        const windowName = document.createElement("div");
        windowName.id = "board-call-popup-window";
        windowName.className = "board-call-popup__detail";
        windowName.hidden = true;

        details.append(service, operator, windowName);
        content.append(label, number, details);
        popup.appendChild(content);
        document.body.appendChild(popup);

        return popup;
    }

    function getCallValue(data, field) {
        const ticket = data && data.ticket ? data.ticket : {};
        return data?.[field] ?? ticket?.[field];
    }

    function showCallPopup(data) {
        if (!getCurrentProfile().callPopup) return;

        const popup = ensureCallPopup();
        const number = getCallValue(data, "number") ?? getCallValue(data, "ticket_number");
        const serviceName = getCallValue(data, "service_name");
        const windowName = getCallValue(data, "window_name");

        document.getElementById("board-call-popup-number").textContent = String(number ?? "");
        setOptionalText(document.getElementById("board-call-popup-service"), serviceName);
        setOptionalText(document.getElementById("board-call-popup-operator"), windowName ? `Оператор ${windowName}` : "");
        setOptionalText(document.getElementById("board-call-popup-window"), "");

        popup.hidden = false;
        popup.classList.add("is-visible");

        if (popupTimer) clearTimeout(popupTimer);
        popupTimer = setTimeout(() => {
            popup.classList.remove("is-visible");
            popup.hidden = true;
            popupTimer = null;
        }, POPUP_DURATION_MS);
    }

    applyCurrentProfile();

    window.BoardProfiles = {
        BOARD_PROFILES,
        getCurrentProfile,
        handleTicketCalled: showCallPopup,
        normalizeBoardProfile,
        shouldHighlightCall() {
            return getCurrentProfile().callHighlight !== false;
        },
        shouldShowLabels() {
            return getCurrentProfile().showLabels !== false;
        },
    };
})();
