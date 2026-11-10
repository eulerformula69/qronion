const SHOW_CALL_BY_NUMBER_STORAGE_KEY = "showCallByNumberButtons";

let showCallByNumberButtons =
    localStorage.getItem(SHOW_CALL_BY_NUMBER_STORAGE_KEY) === "true";

function updateCallByNumberToggle() {
    const toggle = document.getElementById("show-call-by-number-toggle");
    if (toggle) toggle.checked = showCallByNumberButtons;
}

function toggleCallByNumberButtons(enabled) {
    showCallByNumberButtons = enabled === true;
    localStorage.setItem(
        SHOW_CALL_BY_NUMBER_STORAGE_KEY,
        String(showCallByNumberButtons)
    );
    OperatorQueueSections.refresh();
}

async function callTicketByNumber(ticketNumber) {
    closeOperatorMoreMenu();

    if (currentTicketId !== null && currentTicketId !== undefined) {
        showToast("Закончите с текущим клиентом!", "danger");
        return;
    }
    if (deferredTicketCount >= operatorSettings.max_deferred_tickets_per_operator) {
        showToast(
            `Нельзя вызвать нового клиента: у вас отложено ${deferredTicketCount}`,
            "warning"
        );
        OperatorQueueSections.select("deferred");
        return;
    }
    if (!ensureClientOperationsAllowed()) return;

    const normalizedTicketNumber = Number(ticketNumber);
    if (!Number.isInteger(normalizedTicketNumber)) {
        showToast("Некорректный номер талона", "warning");
        return;
    }
    if (!beginOperatorRequest("call-specific")) return;

    try {
        const response = await fetch(`${CONFIG.API_URL}/tickets/call-specific`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "session-id": sessionId
            },
            body: JSON.stringify({number: normalizedTicketNumber})
        });
        const ticket = await response.json();

        if (!response.ok || !ticket.id) {
            showToast(ticket.detail || "Не удалось вызвать данный талон", "danger");
            return;
        }

        stopAutoCall("");
        setCurrentTicket(ticket);
        document.getElementById("current").textContent = ticket.number;
        document.getElementById("current-service").textContent =
            ticket.service_name || "Услуга не указана";
        document.getElementById("toast-notification").style.display = "none";
        loadQueue();
    } catch (error) {
        console.error(error);
        showToast("Ошибка соединения с сервером", "danger");
    } finally {
        endOperatorRequest("call-specific");
    }
}
