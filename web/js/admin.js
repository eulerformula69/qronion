const API = CONFIG.API_URL;
const GRAFANA = CONFIG.GRAFANA_URL;
// Глобальный WebSocket для админки (используем тот же канал, что и терминалы)
let adminSocket = null;

// Проверка авторизации при загрузке страницы + запуск WebSocket
async function init() {

document.addEventListener("DOMContentLoaded", async () => {
    const sessionId = sessionStorage.getItem("session_id");

    if (!sessionId) {
        // Если токена нет, отправляем на страницу входа
        window.location.href = "login.html";
        return;
    }

    try {
        // Проверяем валидность сессии через эндпоинт, защищенный verify_admin_session
        // Например, попытка загрузить список операторов
		const response = await fetch(`${API}/auth/admin`, {
			method: "GET",
			headers: {
				"session-id": sessionId
			}
		});

        if (!response.ok) {
            // Если сервер вернул 401 или 403, значит сессия не админская или истекла
            throw new Error("Доступ запрещен");
        }
        // Подключаем WebSocket после успешной проверки сессии
        initAdminWebSocket();

    } catch (err) {
        console.error("Auth check failed:", err);
        sessionStorage.removeItem("session_id");
        window.location.href = "login.html";
    }
});

}

init();

function initAdminWebSocket() {
    adminSocket = new WebSocket(CONFIG.WS_TERMINAL_URL);

    adminSocket.onopen = () => {
        console.log("Admin WS connected");
        // Сразу отправляем heartbeat, чтобы сервер быстро привязал session_id к WS
        try {
            const sid = sessionStorage.getItem("session_id");
            if (sid) {
                adminSocket.send(JSON.stringify({ type: "ping", session_id: sid }));
            }
        } catch (e) {
            console.debug("Admin WS initial ping error:", e);
        }
    };

    adminSocket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "session_expired") {
            // Сервер явно сообщил об истечении сессии
            sessionStorage.clear();
            window.location.replace("login.html");
        }
    };

    adminSocket.onclose = () => {
        console.log("Admin WS closed, will reconnect");
        setTimeout(initAdminWebSocket, CONFIG.RECONNECT_INTERVAL || 2000);
    };
}

let windows=[]
let operators=[]
let services=[]
let openedServices=null

function resetOpened() {
    openedServices = null;
}

async function fetchJSON(url, options = {}) {
    const sessionId = sessionStorage.getItem("session_id");
    // Гарантируем, что заголовки существуют
    options.headers = {
        ...options.headers,
        "session-id": sessionId
    };

    const res = await fetch(url, options);

    if (res.status === 401) {
        alert("Сессия истекла");
        window.location.href = "login.html";
        return;
    }
    // Если это DELETE и статус 200, res.json() может упасть, если сервер шлет пустой ответ
    if (res.status === 204 || (options.method === 'DELETE' && res.ok)) {
        return { status: "ok" };
    }

    return res.json();
}

async function readResponseData(res) {
    const text = await res.text();
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        return { detail: text };
    }
}

function setTable(html){
document.getElementById("table").innerHTML=html
}

function setForm(html){
document.getElementById("form").innerHTML=html
}

// SERVICES moved to /js/admin/services.js

// WINDOWS moved to /js/admin/windows.js

//////// ОПЕРАТОРЫ
// OPERATORS moved to /js/admin/operators.js

// SETTINGS and STATS moved to /js/admin/settings.js

// MAP moved to /js/admin/map.js

function setActiveTab(tabId) {
    // Убираем класс active у всех кнопок
    document.querySelectorAll('.tabs button').forEach(btn => {
        btn.classList.remove('active');
    });
    // Добавляем класс нужной кнопке
    document.getElementById(tabId).classList.add('active');
}

window.addEventListener("beforeunload", function () {
    // если это обновление страницы — ничего не делаем
    if (isClosingTab || sessionStorage.getItem("refresh")) {
        return;
    }
    // если вкладку закрывают
    if (sessionId) {
		
		ExitPage();

    }

});

async function ExitPage() {
    const sessionId = sessionStorage.getItem("session_id");
    if (!sessionId) return;

    try {
        // Используем fetch, так как нам не важен ответ (мы всё равно закрываем страницу)
        await fetch(`${API}/logout`, {
            method: "POST",
            headers: { "session-id": sessionId }
        });
    } catch (err) {
        console.error("Ошибка при выходе:", err);
    } finally {
        // чищаем данные сессии на клиенте
        sessionStorage.removeItem("session_id");
        location.href = "login.html"; // Перенаправляем на вход
    }
}

// MEDIA FILES moved to /js/admin/media.js

setInterval(() => {
    const sid = sessionStorage.getItem("session_id");
    if (!sid) return;
    if (!adminSocket || adminSocket.readyState !== WebSocket.OPEN) return;

    try {
        adminSocket.send(JSON.stringify({
            type: "ping",
            session_id: sid
        }));
    } catch (e) {
        console.debug("Admin WS ping error:", e);
    }
}, 5000);
