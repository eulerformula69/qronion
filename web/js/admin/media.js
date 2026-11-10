import { fetchJSON, readResponseData } from "./api.js";
import { resetOpened, setActiveTab, setForm, setTable } from "./dom.js";

const API = CONFIG.API_URL;
let mediaProcessingWatchActive = false;
let mediaLastUploadMessage = "";

/// MEDIA FILES 
// In admin.js
export async function loadMedia() {
	resetOpened();
	// Показываем форму и таблицу обратно
    document.getElementById("form").style.display = "block";
    document.getElementById("table").style.display = "table";
 
    setActiveTab('tab-media');
    // Удаляем блок статистики, чтобы он не мешал
    const statsContainer = document.getElementById("stats-container");
    if (statsContainer) statsContainer.remove();	
	
    const sessionId = sessionStorage.getItem("session_id");

    try {
        const response = await fetch(`${API}/admin/media/files`, {
            headers: { "session-id": sessionId }
        });
        const data = await response.json();    
        const items = data.items || (data.files || []).map(filename => ({ filename, status: "ready" }));
        const playlist = data.playlist || [];

        let html = `<tr>
            <th>Файл</th>
            <th>Статус</th>
            <th>Действия</th>
        </tr>`;

        items.forEach(item => {
            const filename = item.filename;
            const webPath = `/queue/media/${filename}`;
            const isIncluded = playlist.includes(webPath);
            const status = item.status || "ready";
            const isReady = status === "ready";
            const statusText = getMediaStatusText(status, isIncluded, item.error);
            const statusColor = getMediaStatusColor(status, isIncluded);
            const compressionLabel = item.compression_label ? ` · ${item.compression_label}` : "";
            const safeFilename = escapeJsString(filename);
            const safeJobId = escapeJsString(item.job_id || "");
            
            html += `<tr>
                <td>${filename}</td>
                <td><b style="color: ${statusColor}">
                    ${escapeHtml(statusText)}
                </b>${escapeHtml(compressionLabel)}</td>
                <td>
                    ${isReady ? `<a href="${webPath}" target="_blank" style="text-decoration: none;">
                        <button style="background: var(--accent); color: white;">Предпросмотр</button>
                    </a>` : ""}
                    ${isReady ? `<button onclick="toggleMedia('${safeFilename}', ${isIncluded})"
                            style="background: ${isIncluded ? '#ffcc00' : 'var(--success)'}; color: white; margin-left: 5px;">
                        ${isIncluded ? 'Исключить' : 'Включить'}
                    </button>` : ""}
                    ${isReady ? `<button onclick="deletePhysicalFile('${safeFilename}')"
                            style="background: var(--danger); color: white; margin-left: 5px;">
                        Удалить
                    </button>` : ""}
                    ${status === "error" && item.job_id ? `<button onclick="retryMediaJob('${safeJobId}')"
                            style="background: var(--accent); color: white; margin-left: 5px;">
                        Повторить
                    </button>` : ""}
                </td>
            </tr>`;
        });

        setTable(html);
        const hasProcessingMedia = items.some(item => item.status === "pending" || item.status === "processing");
        if (mediaProcessingWatchActive && !hasProcessingMedia) {
            mediaLastUploadMessage = "Обработка завершена. Файл готов.";
            mediaProcessingWatchActive = false;
        }
        setForm(`
            <div class="form">
                <h3>Загрузить видео: MP4, WebM, MOV, MKV, AVI, M4V, WMV, MPG, MPEG, 3GP (до 300MB)</h3>
                <input type="file" id="videoFileInput" accept=".mp4,.webm,.mov,.mkv,.avi,.m4v,.wmv,.mpg,.mpeg,.3gp,video/*">
                <label>
                    <input type="checkbox" id="processVideoCheckbox" checked onchange="updateProcessVideoControls()">
                    Обрабатывать видео
                </label>
                <select id="compressionMode">
                    <option value="normal" selected>Обычное качество</option>
                    <option value="high">Высокое качество</option>
                    <option value="compact">Максимальное сжатие</option>
                </select>
                <button onclick="uploadVideoFile()">Начать загрузку</button>
                <div id="uploadStatus"></div>
            </div>
        `);
        updateProcessVideoControls();
        if (mediaLastUploadMessage) {
            document.getElementById("uploadStatus").textContent = mediaLastUploadMessage;
        }
        if (hasProcessingMedia) {
            setTimeout(() => {
                if (document.getElementById("tab-media")?.classList.contains("active")) {
                    loadMedia();
                }
            }, 5000);
        }
    } catch (e) {
        console.error("Ошибка загрузки медиа:", e);
        setTable("<tr><td>Ошибка связи с сервером</td></tr>");
    }
}

export function updateProcessVideoControls() {
    const checkbox = document.getElementById("processVideoCheckbox");
    const mode = document.getElementById("compressionMode");
    if (!checkbox || !mode) return;
    mode.disabled = !checkbox.checked;
}

function getMediaStatusText(status, isIncluded, error) {
    if (status === "pending") return "Ожидает обработки";
    if (status === "processing") return "Обработка";
    if (status === "error") return `Ошибка обработки${error ? ": " + error : ""}`;
    return isIncluded ? "В плейлисте" : "Исключен";
}

function getMediaStatusColor(status, isIncluded) {
    if (status === "pending" || status === "processing") return "var(--accent)";
    if (status === "error") return "var(--danger)";
    return isIncluded ? "var(--success)" : "var(--text-muted)";
}

function escapeJsString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

export async function retryMediaJob(jobId) {
    const status = document.getElementById("uploadStatus");
    if (status) status.textContent = "Повторная обработка...";

    const response = await fetch(`${API}/admin/media/job/${jobId}/retry`, {
        method: "POST",
        headers: { "session-id": sessionStorage.getItem("session_id") }
    });

    if (response.ok) {
        loadMedia();
    } else {
        const err = await readResponseData(response);
        if (status) status.textContent = `Ошибка повтора (${response.status}): ${err.detail || "нет подробностей"}`;
    }
}

export async function toggleMedia(filename, isCurrentlyIncluded) {
    const webPath = `/queue/media/${filename}`;
    const action = isCurrentlyIncluded ? "delete" : "add";

    await fetchJSON(`${API}/admin/media/playlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
            path: webPath, 
            action: action 
        })
    });

    loadMedia(); // Refresh table
}

// Logic to delete the file from the disk
export async function deletePhysicalFile(filename) {
    if (!confirm(`Удалить файл ${filename} с сервера навсегда?`)) return;

    const response = await fetch(`${API}/admin/media/file/${filename}`, {
        method: "DELETE",
        headers: { "session-id": sessionStorage.getItem("session_id") }
    });

    if (response.ok) {
        loadMedia();
    }
}

// Logic for the "Include/Exclude" toggle
export async function toggleInPlaylist(filename, currentlyIncluded) {
    const action = currentlyIncluded ? "delete" : "add";
    const path = `/queue/media/${filename}`;

    const res = await fetchJSON(`${API}/admin/media/playlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path, action: action })
    });
    if (res) loadMedia();
}

// Logic for physical deletion
export async function deleteFromServer(filename) {
    if (!confirm(`Вы уверены, что хотите полностью удалить ${filename} с сервера?`)) return;

    const sessionId = sessionStorage.getItem("session_id");
    const response = await fetch(`${API}/admin/media/file/${filename}`, {
        method: "DELETE",
        headers: { "session-id": sessionId }
    });

    if (response.ok) {
        alert("Файл удален");
        loadMedia();
    }
}

export async function uploadVideoFile() {
    const fileInput = document.getElementById('videoFileInput');
    const status = document.getElementById('uploadStatus');
    const file = fileInput.files[0];

    if (!file) return;

    if (file.size > 300 * 1024 * 1024) {
        alert("Файл слишком большой (> 300MB)");
        return;
    }

    const formData = new FormData();
    const processVideo = document.getElementById("processVideoCheckbox")?.checked !== false;
    formData.append("file", file);
    formData.append("process_video", processVideo ? "true" : "false");
    formData.append("compression_mode", document.getElementById("compressionMode")?.value || "normal");
    status.textContent = "Загрузка...";

    let response;
    try {
        response = await fetch(`${API}/admin/media/upload`, {
            method: "POST",
            headers: { "session-id": sessionStorage.getItem("session_id") },
            body: formData
        });
    } catch (error) {
        status.textContent = "Ошибка загрузки: сервер недоступен";
        return;
    }

    if (response.ok) {
        const data = await readResponseData(response);
        if (data.status === "ready") {
            mediaLastUploadMessage = "Загружено без обработки. Файл готов.";
            mediaProcessingWatchActive = false;
        } else {
            mediaLastUploadMessage = "Загружено. Видео обрабатывается...";
            mediaProcessingWatchActive = true;
        }
        status.textContent = mediaLastUploadMessage;
        loadMedia();
    } else {
        const err = await readResponseData(response);
        status.textContent = `Ошибка загрузки (${response.status}): ${err.detail || "нет подробностей"}`;
    }
}

export async function addMedia() {
    const path = document.getElementById("newVideoPath").value;
    if (!path) return;

    const res = await fetchJSON(`${API}/admin/media/playlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path, action: "add" })
    });

    if (res) loadMedia();
}

export async function deleteMedia(index) {
    if (!confirm("Удалить это видео из плейлиста?")) return;

    const res = await fetchJSON(`${API}/admin/media/playlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: index, action: "delete" })
    });

    if (res) loadMedia();
}

// Логика фонового heartbeat для админа через WebSocket (вместо HTTP /ping)
