let ctx;
let mediaProcessingWatchActive = false;
let mediaLastUploadMessage = "";
let mediaItems = [];
let mediaPlaylist = [];

const videoPlaceholderIcon = `
    <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="5" width="18" height="14" rx="3"></rect>
        <path d="m10 9 5 3-5 3Z"></path>
    </svg>
`;

export async function mount(context) {
    ctx = context;
    await render();
}

async function render() {
    const data = await ctx.api.request("/admin/media/files");
    mediaItems = data.items || (data.files || []).map(filename => ({filename, status: "ready"}));
    mediaPlaylist = data.playlist || [];
    const hasProcessing = mediaItems.some(item => ["pending", "processing"].includes(item.status));

    if (mediaProcessingWatchActive && !hasProcessing) {
        mediaLastUploadMessage = "Обработка завершена. Файл готов.";
        mediaProcessingWatchActive = false;
    }

    ctx.view.innerHTML = `
        <section class="admin-media-page" aria-label="Управление видеофайлами">
            <div class="admin-media-toolbar">
                ${ctx.ui.button("Загрузить файл", {variant: "primary", action: "open-upload"})}
            </div>
            <div id="uploadStatus" class="admin-upload-status" aria-live="polite">${ctx.ui.escapeHtml(mediaLastUploadMessage)}</div>
            <div class="admin-media-list">
                ${mediaItems.length ? mediaItems.map(renderMediaCard).join("") : renderEmptyState()}
            </div>
        </section>
    `;

    ctx.view.onclick = handleClick;
    if (hasProcessing) setTimeout(() => location.hash === "#media" && render(), 5000);
}

function renderMediaCard(item) {
    const webPath = `/queue/media/${encodeURIComponent(item.filename)}`;
    const framePath = `${webPath}#t=0.1`;
    const included = mediaPlaylist.includes(`/queue/media/${item.filename}`);
    const ready = (item.status || "ready") === "ready";
    const safeFilename = ctx.ui.escapeHtml(item.filename);
    const status = item.status || "ready";
    return `
        <article class="admin-media-card admin-media-card-${status}${ready && !included ? " admin-media-card-inactive" : ""}">
            ${ready ? `
                <a class="admin-media-preview" href="${webPath}" target="_blank" rel="noopener" title="Открыть видео в новой вкладке" aria-label="Открыть ${safeFilename} в новой вкладке">
                    <video src="${framePath}" preload="metadata" muted playsinline aria-hidden="true"></video>
                    <span class="admin-media-preview-play" aria-hidden="true">${videoPlaceholderIcon}</span>
                </a>
            ` : `<div class="admin-media-preview admin-media-preview-disabled">
                ${videoPlaceholderIcon}<span>Кадр появится после обработки</span>
            </div>`}
            <div class="admin-media-details">
                <div class="admin-media-heading">
                    <strong title="${safeFilename}">${safeFilename}</strong>
                </div>
                <div class="admin-media-meta">
                    <span>${fileType(item.filename)}</span>
                    <span>${formatBytes(item.size_bytes)}</span>
                    ${item.compression_label ? `<span>FFmpeg: ${ctx.ui.escapeHtml(item.compression_label)}</span>` : `<span>Без обработки</span>`}
                </div>
                ${status === "processing" || status === "pending" ? `<div class="admin-media-progress"><span></span></div>` : ""}
                ${status === "error" ? `<p class="admin-media-error">${ctx.ui.escapeHtml(item.error || "Не удалось обработать видео")}</p>` : ""}
            </div>
            <div class="admin-media-actions">
                ${ready ? renderPlaylistSwitch(item.filename, included) : ""}
                ${status === "error" && item.job_id ? ctx.ui.button("Повторить", {variant: "secondary", action: "retry", id: item.job_id}) : ""}
                ${ready ? ctx.ui.button("Удалить с сервера", {variant: "danger", action: "delete", id: item.filename}) : ""}
            </div>
        </article>
    `;
}

function renderPlaylistSwitch(filename, included) {
    return `
        <label class="admin-media-playlist-switch">
            <input type="checkbox" data-action="toggle" data-id="${ctx.ui.escapeHtml(filename)}" ${included ? "checked" : ""}>
            <i aria-hidden="true"></i>
            <span>${included ? "В плейлисте" : "Не в плейлисте"}</span>
        </label>
    `;
}

function renderEmptyState() {
    return `<div class="admin-card admin-media-empty"><strong>Видеофайлов пока нет</strong><span>Загрузите первое видео для табло.</span></div>`;
}

function openUploadDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "admin-media-dialog";
    dialog.innerHTML = `
        <form id="media-upload-form" method="dialog">
            <div class="admin-media-dialog-heading">
                <div><h3>Загрузить видео</h3><p>Выберите файл и параметры подготовки для табло.</p></div>
                <button class="admin-media-dialog-close" type="button" data-dialog-action="close" aria-label="Закрыть">×</button>
            </div>
            <label class="admin-file-picker">
                <input class="admin-file-input" type="file" name="file" accept=".mp4,.webm,.mov,.mkv,.avi,.m4v,.wmv,.mpg,.mpeg,.3gp,video/*">
                <span class="admin-file-action">Выбрать файл</span>
                <span class="admin-file-name" data-file-name>Файл не выбран</span>
            </label>
            <label class="admin-field"><span>Название</span><input class="admin-input" name="display_name" placeholder="Например, День открытых дверей"></label>
            <label class="admin-media-process-option"><input type="checkbox" name="process_video" checked><span><strong>Подготовить для табло</strong><small>FFmpeg приведёт видео к совместимому формату MP4.</small></span></label>
            <label class="admin-field admin-media-quality"><span>Качество</span>
                <select class="admin-input" name="compression_mode">
                    <option value="normal" selected>Обычное — баланс качества и размера</option>
                    <option value="high">Высокое — крупнее файл</option>
                    <option value="compact">Компактное — меньше размер</option>
                    <option value="custom">Свои параметры — для опытных</option>
                </select>
            </label>
            <label class="admin-field admin-media-custom-command" hidden><span>Командная строка FFmpeg</span>
                <textarea class="admin-input admin-textarea" name="custom_ffmpeg_command" rows="3" spellcheck="false">ffmpeg -i "{input}" "{output}"</textarea>
                <small>Оставьте {input} и {output}: система подставит безопасные пути к файлам.</small>
            </label>
            <div class="admin-media-result" data-upload-result>Выберите файл — здесь появится ожидаемый результат.</div>
            <div class="admin-media-dialog-actions">
                ${ctx.ui.button("Отмена", {variant: "secondary", className: "admin-media-cancel"})}
                ${ctx.ui.button("Загрузить", {variant: "primary", action: "upload"})}
            </div>
            <div class="admin-upload-status" data-dialog-status aria-live="polite"></div>
        </form>
    `;
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelector("[data-dialog-action=close]").onclick = () => dialog.close();
    dialog.querySelector(".admin-media-cancel").onclick = () => dialog.close();
    dialog.querySelector("[name=file]").onchange = event => updateUploadPreview(event.target, dialog);
    dialog.querySelector("[name=process_video]").onchange = event => {
        dialog.querySelector("[name=compression_mode]").disabled = !event.target.checked;
        updateCustomCommandVisibility(dialog);
        updateExpectedResult(dialog);
    };
    dialog.querySelector("[name=compression_mode]").onchange = () => {
        updateCustomCommandVisibility(dialog);
        updateExpectedResult(dialog);
    };
    dialog.onclick = event => {
        if (event.target === dialog) dialog.close();
        const button = event.target.closest('[data-action="upload"]');
        if (button) upload(dialog);
    };
    dialog.showModal();
}

function updateUploadPreview(input, dialog) {
    const file = input.files[0];
    dialog.querySelector("[data-file-name]").textContent = file?.name || "Файл не выбран";
    const nameInput = dialog.querySelector("[name=display_name]");
    if (file && !nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, "");
    updateExpectedResult(dialog);
}

function updateExpectedResult(dialog) {
    const form = dialog.querySelector("form");
    const file = form.elements.file.files[0];
    const output = dialog.querySelector("[data-upload-result]");
    if (!file) return;
    const processed = form.elements.process_video.checked;
    const quality = form.elements.compression_mode.selectedOptions[0]?.text.split(" — ")[0];
    const custom = form.elements.compression_mode.value === "custom";
    output.innerHTML = `<strong>Исходный файл:</strong> ${ctx.ui.escapeHtml(file.name)} · ${formatBytes(file.size)}<br><strong>Результат:</strong> ${processed ? (custom ? "MP4 · свои параметры FFmpeg" : `MP4 · ${ctx.ui.escapeHtml(quality)} качество`) : "исходный файл без изменений"}`;
}

function updateCustomCommandVisibility(dialog) {
    const customField = dialog.querySelector(".admin-media-custom-command");
    const form = dialog.querySelector("form");
    customField.hidden = !form.elements.process_video.checked || form.elements.compression_mode.value !== "custom";
}

function fileType(filename) {
    const extension = filename.split(".").pop()?.toUpperCase();
    return extension ? `Видео ${extension}` : "Видео";
}

function formatBytes(value) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return "Размер не указан";
    const units = ["Б", "КБ", "МБ", "ГБ"];
    let size = Number(value);
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toLocaleString("ru-RU", {maximumFractionDigits: unit ? 1 : 0})} ${units[unit]}`;
}

async function handleClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;
    const {action, id} = actionElement.dataset;
    if (action === "open-upload") openUploadDialog();
    if (action === "delete") await deleteFile(id);
    if (action === "retry") await retry(id);
}

async function upload(dialog) {
    const form = dialog.querySelector("form");
    const file = form.elements.file.files[0];
    const status = dialog.querySelector("[data-dialog-status]");
    if (!file) return ctx.toast("Выберите файл", "error");
    if (file.size > 300 * 1024 * 1024) return ctx.toast("Файл слишком большой (более 300 МБ)", "error");

    const displayName = form.elements.display_name.value.trim();
    const extension = file.name.match(/\.[^.]+$/)?.[0] || "";
    const uploadFile = displayName ? new File([file], `${displayName}${extension}`, {type: file.type, lastModified: file.lastModified}) : file;
    const payload = new FormData();
    payload.append("file", uploadFile);
    payload.append("process_video", form.elements.process_video.checked ? "true" : "false");
    payload.append("compression_mode", form.elements.compression_mode.value || "normal");
    payload.append("custom_ffmpeg_command", form.elements.custom_ffmpeg_command.value.trim());
    status.textContent = "Загрузка…";
    form.querySelector('[data-action="upload"]').disabled = true;

    try {
        const response = await ctx.api.formData("/admin/media/upload", payload, {method: "POST"});
        mediaLastUploadMessage = response.status === "ready" ? "Файл загружен и готов." : "Файл загружен и обрабатывается.";
        mediaProcessingWatchActive = response.status !== "ready";
        dialog.close();
        await render();
    } catch (error) {
        status.textContent = error.message || "Не удалось загрузить файл";
        form.querySelector('[data-action="upload"]').disabled = false;
    }
}

async function toggle(input) {
    const filename = input.dataset.id;
    const checked = input.checked;
    const path = `/queue/media/${filename}`;
    const card = input.closest(".admin-media-card");

    updatePlaylistCard(card, checked);
    input.disabled = true;
    card?.setAttribute("aria-busy", "true");

    try {
        await ctx.api.json("/admin/media/playlist", {
            method: "POST",
            body: {path, action: checked ? "add" : "delete"}
        });
        mediaPlaylist = checked
            ? [...new Set([...mediaPlaylist, path])]
            : mediaPlaylist.filter(item => item !== path);
    } catch (error) {
        input.checked = !checked;
        updatePlaylistCard(card, !checked);
        ctx.toast(error.message || "Не удалось изменить плейлист", "error");
    } finally {
        input.disabled = false;
        card?.removeAttribute("aria-busy");
    }
}

function updatePlaylistCard(card, included) {
    if (!card) return;
    card.classList.toggle("admin-media-card-inactive", !included);
    const label = card.querySelector(".admin-media-playlist-switch > span");
    if (label) label.textContent = included ? "В плейлисте" : "Не в плейлисте";
}

async function deleteFile(filename) {
    if (!ctx.ui.confirmAction(`Удалить «${filename}» с сервера навсегда? Видео также исчезнет из плейлиста. Это действие нельзя отменить.`)) return;
    await ctx.api.request(`/admin/media/file/${encodeURIComponent(filename)}`, {method: "DELETE"});
    mediaLastUploadMessage = `Файл «${filename}» удалён с сервера.`;
    await render();
}

async function retry(jobId) {
    await ctx.api.request(`/admin/media/job/${encodeURIComponent(jobId)}/retry`, {method: "POST"});
    mediaProcessingWatchActive = true;
    await render();
}

document.addEventListener("change", event => {
    const toggleInput = event.target.closest('.admin-media-playlist-switch input[data-action="toggle"]');
    if (toggleInput && location.hash === "#media") toggle(toggleInput);
});
