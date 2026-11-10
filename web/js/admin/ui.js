export function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

export function button(label, options = {}) {
    const variant = options.variant || "secondary";
    const attrs = [
        `class="admin-btn admin-btn-${variant}${options.className ? ` ${options.className}` : ""}"`,
        options.type ? `type="${options.type}"` : `type="button"`,
        options.action ? `data-action="${escapeHtml(options.action)}"` : "",
        options.id !== undefined ? `data-id="${escapeHtml(options.id)}"` : "",
        options.disabled ? "disabled" : "",
        options.title ? `title="${escapeHtml(options.title)}"` : ""
    ].filter(Boolean).join(" ");

    return `<button ${attrs}>${options.icon ? `<span class="admin-btn-icon">${options.icon}</span>` : ""}${escapeHtml(label)}</button>`;
}

export function badge(label, tone = "neutral") {
    return `<span class="admin-badge admin-badge-${tone}">${escapeHtml(label)}</span>`;
}

export function statCard(label, value, tone = "blue") {
    return `
        <article class="admin-stat-card admin-stat-${tone}">
            <span class="admin-stat-icon"></span>
            <span class="admin-stat-label">${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
        </article>
    `;
}

export function table(headers, rows, options = {}) {
    return `
        <div class="admin-card admin-table-card">
            ${options.title ? `<div class="admin-card-title">${escapeHtml(options.title)}</div>` : ""}
            <div class="admin-table-scroll">
                <table class="admin-table">
                    <thead><tr>${headers.map(renderTableHeader).join("")}</tr></thead>
                    <tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}" class="admin-empty-cell">Нет данных</td></tr>`}</tbody>
                </table>
            </div>
        </div>
    `;
}

export function sortHeader(label, key, sortState) {
    return {
        label,
        sortKey: key,
        direction: sortState?.key === key ? sortState.direction : null
    };
}

function renderTableHeader(header) {
    if (!header || typeof header !== "object") return `<th>${escapeHtml(header)}</th>`;
    if (!header.sortKey) return `<th>${escapeHtml(header.label)}</th>`;
    const directionLabel = header.direction === "asc" ? " по возрастанию" : header.direction === "desc" ? " по убыванию" : "";
    return `
        <th>
            <button class="admin-sort-header" type="button" data-action="sort" data-sort-key="${escapeHtml(header.sortKey)}">
                <span>${escapeHtml(header.label)}</span>
                <span class="admin-sort-indicator" aria-hidden="true">${header.direction === "asc" ? "↑" : header.direction === "desc" ? "↓" : ""}</span>
                <span class="admin-sr-only">${escapeHtml(directionLabel)}</span>
            </button>
        </th>
    `;
}

export function field(label, inputHtml, hint = "") {
    return `
        <label class="admin-field">
            <span>${escapeHtml(label)}</span>
            ${inputHtml}
            ${hint ? `<small>${escapeHtml(hint)}</small>` : ""}
        </label>
    `;
}

export function input(name, value = "", attrs = "") {
    return `<input class="admin-input" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${attrs}>`;
}

export function textarea(name, value = "", attrs = "") {
    return `<textarea class="admin-input admin-textarea" name="${escapeHtml(name)}" ${attrs}>${escapeHtml(value)}</textarea>`;
}

export function select(name, options, selectedValue = "", attrs = "") {
    const selectedString = selectedValue === null || selectedValue === undefined ? "" : String(selectedValue);
    return `
        <select class="admin-input" name="${escapeHtml(name)}" ${attrs}>
            ${options.map(option => {
                const value = option.value === null || option.value === undefined ? "" : String(option.value);
                return `<option value="${escapeHtml(value)}" ${value === selectedString ? "selected" : ""}>${escapeHtml(option.label)}</option>`;
            }).join("")}
        </select>
    `;
}

export function switchField(name, checked) {
    return `
        <label class="admin-switch">
            <input type="checkbox" name="${escapeHtml(name)}" ${checked ? "checked" : ""}>
            <span></span>
        </label>
    `;
}

export function showToast(message, tone = "info") {
    const host = document.getElementById("admin-toast-host");
    if (!host) return;
    const toast = document.createElement("div");
    toast.className = `admin-toast admin-toast-${tone}`;
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
}

export function confirmAction(message) {
    return window.confirm(message);
}
