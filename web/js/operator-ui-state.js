const activeOperatorRequests = new Set();

function beginOperatorRequest(key) {
    if (activeOperatorRequests.size > 0) return false;
    activeOperatorRequests.add(key);
    refreshOperatorUiState();
    return true;
}

function endOperatorRequest(key) {
    activeOperatorRequests.delete(key);
    refreshOperatorUiState();
}

function refreshOperatorUiState() {
    const online = currentWindowStatus === "online";
    const hasTicket = Boolean(currentTicketId);
    const busy = activeOperatorRequests.size > 0;

    const statusToggle = document.getElementById("window-status-toggle");
    if (statusToggle) statusToggle.disabled = busy;

    document.querySelectorAll("[data-call-action]").forEach(button => {
        button.disabled = !online || hasTicket || busy;
    });
    document.querySelectorAll("[data-current-ticket-action]").forEach(button => {
        const isCalled = currentTicketStatus === "called";
        const isServing = currentTicketStatus === "serving";
        const statusAllowsAction = {
            "start-service-btn": isCalled,
            "finish-btn": isServing,
            "redirect-btn": isCalled || isServing,
            "recall-btn": isCalled,
            "cancel-btn": isCalled,
            "defer-ticket-btn": isCalled || isServing,
            "return-to-queue-btn": isCalled || isServing
        }[button.id] ?? (isCalled || isServing);
        const waitingBeforeFinish = (
            button.id === "finish-btn" && isCalledTicketWaitActive()
        );
        const waitingBeforeRecall = button.id === "recall-btn" && recallCooldown;
        button.disabled = !hasTicket || !statusAllowsAction || busy || (
            waitingBeforeRecall
        ) || waitingBeforeFinish;
        button.classList.toggle(
            "current-ticket-action-inactive",
            waitingBeforeFinish || waitingBeforeRecall
        );
    });
    document.querySelectorAll(".queue-resume-btn").forEach(button => {
        button.disabled = !online || hasTicket || busy;
    });

    const displayZone = document.querySelector(".display-zone");
    if (displayZone) {
        displayZone.classList.toggle("current-ticket-actions-inactive", !hasTicket);
        displayZone.classList.toggle("operator-work-disabled", !online && !hasTicket);
        displayZone.dataset.ticketStatus = currentTicketStatus || "none";
    }

}
