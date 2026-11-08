// Keep an uncertain issuance across retries and page reloads.
async function submitTicketRequest(serviceId, windowId, serviceName, sessionId) {
    const storageKey = "pending-ticket-creation";
    let pending = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (pending && (pending.service_id !== serviceId || pending.window_id !== windowId)) {
        throw new Error(`Сначала повторите получение талона на услугу «${pending.serviceName}»: результат предыдущего запроса неизвестен.`);
    }
    if (!pending) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 15) | 64;
        bytes[8] = (bytes[8] & 63) | 128;
        const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
        const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        pending = { service_id: serviceId, window_id: windowId, serviceName, request_id: requestId };
        localStorage.setItem(storageKey, JSON.stringify(pending));
    }
    for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(`${CONFIG.API_URL}/tickets/`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "session-id": sessionId },
                body: JSON.stringify(pending),
                signal: controller.signal
            });
            const data = await response.json();
            if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 401)) {
                localStorage.removeItem(storageKey);
            }
            if (response.status >= 500 && attempt === 0) continue;
            return { response, data };
        } catch (error) {
            if (attempt === 1) {
                throw new Error("Не удалось получить ответ. Повторите выбор той же услуги: новый талон не будет создан повторно.");
            }
        } finally {
            clearTimeout(timeout);
        }
    }
}
