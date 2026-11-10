const API = CONFIG.API_URL;

export class ApiError extends Error {
    constructor(message, response, data = {}) {
        super(message);
        this.name = "ApiError";
        this.response = response;
        this.status = response?.status;
        this.data = data;
    }
}

export function getSessionId() {
    return sessionStorage.getItem("session_id");
}

export function redirectToLogin() {
    sessionStorage.removeItem("session_id");
    window.location.replace("login.html");
}

export async function readResponseData(response) {
    const text = await response.text();
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        return { detail: text };
    }
}

function buildUrl(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${API}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const sessionId = getSessionId();

    if (sessionId) headers.set("session-id", sessionId);
    if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    const response = await fetch(buildUrl(path), {
        ...options,
        headers
    });

    const data = await readResponseData(response);

    if (response.status === 401 || response.status === 403) {
        redirectToLogin();
        throw new ApiError("Сессия истекла", response, data);
    }

    if (!response.ok) {
        throw new ApiError(data.detail || `Ошибка запроса (${response.status})`, response, data);
    }

    if (response.status === 204 || (options.method === "DELETE" && !Object.keys(data).length)) {
        return { status: "ok" };
    }

    return data;
}

export function json(path, options = {}) {
    const body = options.body && typeof options.body !== "string"
        ? JSON.stringify(options.body)
        : options.body;
    return request(path, {...options, body});
}

export function formData(path, form, options = {}) {
    return request(path, {...options, body: form});
}

export async function logout() {
    const sessionId = getSessionId();
    if (!sessionId) {
        redirectToLogin();
        return;
    }

    try {
        await fetch(buildUrl("/logout"), {
            method: "POST",
            headers: {"session-id": sessionId}
        });
    } finally {
        redirectToLogin();
    }
}

// Backward-compatible exports for the existing map module.
export const fetchJSON = request;
