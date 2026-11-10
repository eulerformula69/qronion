const OperatorQueueSections = (() => {
    const legacyReasonLabels = {
        fills_documents: "Заполняет документы",
        pays: "Оплачивает",
        went_for_documents: "Пошёл за документами",
        missing_document: "Нет нужного документа",
        no_show: "Клиент не явился",
        refused_service: "Отказался от услуги",
        wrong_ticket: "Ошибочный талон",
        other: "Другое"
    };
    const deferReasons = [
        { value: "Заполняет документы", label: "Заполняет документы" },
        { value: "Оплачивает", label: "Оплачивает" },
        { value: "Пошёл за документами", label: "Пошёл за документами" },
        { value: "Нет нужного документа", label: "Нет нужного документа" },
        { value: "Другое", label: "Другое" }
    ];
    const cancelReasons = [
        { value: "Клиент не явился", label: "Клиент не явился" },
        { value: "Отказался от услуги", label: "Отказался от услуги" },
        { value: "Ошибочный талон", label: "Ошибочный талон" },
        { value: "Нет нужного документа", label: "Нет нужного документа" },
        { value: "Другое", label: "Другое" }
    ];
    const sectionLabels = {
        waiting: "Ожидающие",
        deferred: "Отложенные",
        cancelled: "Отменённые",
        served: "Обслуженные"
    };
    const statusLabels = {
        waiting: "Ожидает",
        called: "В обслуживании",
        deferred: "Отложен",
        cancelled: "Отменён",
        finished: "Завершён"
    };
    const completionReasonLabels = {
        completed: "Обслужен",
        redirected: "Перенаправлен",
        cancelled: "Отменён"
    };

    let selectedSection = "waiting";
    let sections = {
        waiting: [],
        deferred: [],
        cancelled: [],
        served: []
    };

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function deferReasonLabel(reason) {
        return deferReasons.find(item => item.value === reason)?.label
            || cancelReasons.find(item => item.value === reason)?.label
            || legacyReasonLabels[reason]
            || completionReasonLabels[reason]
            || reason
            || "";
    }

    function applyReasonOptions(target, options) {
        const nextOptions = Array.isArray(options)
            ? options
                .map(item => String(item?.text || "").trim())
                .filter(Boolean)
                .map(text => ({ value: text, label: text }))
            : [];
        if (!nextOptions.some(item => item.value === "Другое")) {
            nextOptions.push({ value: "Другое", label: "Другое" });
        }
        if (nextOptions.length) {
            target.splice(0, target.length, ...nextOptions);
        }
    }

    function setReasonOptions(options = {}) {
        applyReasonOptions(cancelReasons, options.cancel_reason_options);
        applyReasonOptions(deferReasons, options.defer_reason_options);
    }

    function ticketStatusLabel(ticket) {
        if (ticket.status === "finished" && ticket.completion_reason) {
            return completionReasonLabels[ticket.completion_reason] || "Завершён";
        }
        return statusLabels[ticket.status] || ticket.status || "—";
    }

    function ticketMainTime(ticket, section) {
        if (section === "deferred") return ticket.deferred_at || ticket.called_at || ticket.created_at;
        if (section === "served" || section === "cancelled") return ticket.finished_at || ticket.called_at || ticket.created_at;
        return ticket.called_at || ticket.created_at;
    }

    function countsFromSections() {
        return {
            waiting: sections.waiting.length,
            deferred: sections.deferred.length,
            cancelled: sections.cancelled.length,
            served: sections.served.length
        };
    }

    function updateTabs(counts = countsFromSections()) {
        Object.keys(sectionLabels).forEach(section => {
            const counter = document.getElementById(`queue-count-${section}`);
            if (counter) counter.textContent = counts[section] ?? 0;

            const button = document.querySelector(`.queue-column[data-section="${section}"]`);
            if (button) button.classList.toggle("active", section === selectedSection);
        });
    }

    function render() {
        const panel = document.getElementById("queue-list");
        if (!panel) return;

        const tickets = sections[selectedSection] || [];
        if (!tickets.length) {
            const label = sectionLabels[selectedSection] || "Список";
            panel.innerHTML = `<div style='color:var(--text-muted); padding:20px;'>${label}: нет талонов</div>`;
            return;
        }

        panel.innerHTML = tickets.map(ticket => {
            const reason = deferReasonLabel(ticket.defer_reason || ticket.cancel_reason || ticket.completion_reason || ticket.reason);
            const canResume = selectedSection === "deferred" || selectedSection === "cancelled";
            const resumeDisabled = (
                typeof currentWindowStatus !== "undefined" && currentWindowStatus !== "online"
            ) || (typeof currentTicketId !== "undefined" && Boolean(currentTicketId));
            const canCallByNumber = selectedSection === "waiting"
                && typeof showCallByNumberButtons !== "undefined"
                && showCallByNumberButtons;
            const redirected = Boolean(ticket.is_redirected_to_window);
            return `
                <div class="queue-item queue-detail-item ${redirected ? "queue-item-redirected" : ""}">
                    <div class="queue-detail-head">
                        <span>№ ${escapeHtml(ticket.number)}</span>
                        <span>${escapeHtml(ticketMainTime(ticket, selectedSection) || "—")}</span>
                    </div>
                    <div class="queue-service-name">${escapeHtml(ticket.service_name || "Услуга не указана")}</div>
                    <div class="queue-detail-meta">
                        <span>${escapeHtml(ticketStatusLabel(ticket))}</span>
                        <span>Создан: ${escapeHtml(ticket.created_at || "—")}</span>
                        ${ticket.called_at ? `<span>Вызван: ${escapeHtml(ticket.called_at)}</span>` : ""}
                        ${ticket.finished_at ? `<span>Завершён: ${escapeHtml(ticket.finished_at)}</span>` : ""}
                        ${reason ? `<span>Причина: ${escapeHtml(reason)}</span>` : ""}
                    </div>
                    ${redirected ? '<div class="redirect-badge">Перенаправлено</div>' : ''}
                    ${canCallByNumber ? `
                        <div class="queue-ticket-actions">
                            <button class="btn-primary queue-call-by-number-btn" data-call-action type="button" onclick="callTicketByNumber(${Number(ticket.number)})">Вызвать по номеру</button>
                        </div>
                    ` : ""}
                    ${canResume ? `
                        <div class="queue-ticket-actions">
                            <button class="btn-primary queue-resume-btn" type="button" onclick="resumeTicket(${Number(ticket.id)}, '${selectedSection}')" ${resumeDisabled ? "disabled" : ""}>Вернуть в обслуживание</button>
                            ${selectedSection === "deferred" ? `<button class="btn-outline btn-danger-outline queue-cancel-deferred-btn" type="button" onclick="cancelDeferredTicket(${Number(ticket.id)}, ${Number(ticket.number)})" ${resumeDisabled ? "disabled" : ""}>Отменить талон</button>` : ""}
                        </div>
                    ` : ""}
                </div>
            `;
        }).join("");
        if (typeof refreshOperatorUiState === "function") refreshOperatorUiState();
    }

    function select(section) {
        if (!sectionLabels[section]) return;
        selectedSection = section;
        updateTabs();
        render();
    }

    function setSections(nextSections, counts) {
        sections = nextSections || sections;
        updateTabs(counts || countsFromSections());
        render();
    }

    return {
        deferReasons,
        cancelReasons,
        setReasonOptions,
        select,
        setSections,
        refresh: render
    };
})();

function selectQueueSection(section) {
    OperatorQueueSections.select(section);
}
