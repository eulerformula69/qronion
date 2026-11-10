let ctx;
let scope = "admin";
let documents = [];
let current = null;
let dirty = false;
let editing = false;

export async function mount(context) {
    ctx = context;
    ctx.view.innerHTML = `<div class="docs-app">
        <aside class="docs-sidebar">
            <div class="docs-scope" role="tablist"><button data-scope="admin" class="active">Администратор</button><button data-scope="operator">Оператор</button></div>
            <div class="docs-tree-toolbar"><strong>Документы</strong><button class="admin-btn admin-btn-icon" data-action="doc-create" title="Создать">+</button></div>
            <nav id="docs-tree" class="docs-tree"></nav>
        </aside>
        <section class="docs-workspace">
            <div class="docs-toolbar">
                <span id="docs-current-path">Документ не выбран</span>
                <input id="docs-image-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
                <div class="docs-read-actions">
                    ${ctx.ui.button("Переименовать", {variant: "ghost", action: "doc-rename"})}
                    ${ctx.ui.button("Удалить", {variant: "danger", action: "doc-delete"})}
                    ${ctx.ui.button("Редактировать", {variant: "primary", action: "doc-edit"})}
                </div>
                <div class="docs-edit-actions" hidden>
                    ${ctx.ui.button("Картинка", {variant: "ghost", action: "doc-image"})}
                    ${ctx.ui.button("Отмена", {variant: "ghost", action: "doc-cancel"})}
                    ${ctx.ui.button("Сохранить", {variant: "primary", action: "doc-save"})}
                </div>
            </div>
            <div class="docs-document">
                <article id="docs-content" class="docs-rendered"></article>
                <textarea id="docs-editor" aria-label="Markdown редактор" spellcheck="true" hidden></textarea>
            </div>
        </section>
    </div>`;
    bindEvents();
    await loadTree();
}

export function unmount() {
    window.removeEventListener("beforeunload", warnUnsaved);
}

function bindEvents() {
    ctx.view.addEventListener("click", handleClick);
    document.getElementById("docs-editor").addEventListener("input", () => { dirty = true; });
    document.getElementById("docs-image-input").addEventListener("change", uploadImage);
    window.addEventListener("beforeunload", warnUnsaved);
}

async function handleClick(event) {
    const scopeButton = event.target.closest("[data-scope]");
    if (scopeButton) {
        if (!confirmDiscard()) return;
        scope = scopeButton.dataset.scope;
        current = null;
        ctx.view.querySelectorAll("[data-scope]").forEach(button => button.classList.toggle("active", button === scopeButton));
        await loadTree(); return;
    }
    const documentButton = event.target.closest("[data-doc-path]");
    if (documentButton) { if (confirmDiscard()) await openDocument(documentButton.dataset.docPath); return; }
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "doc-edit") setEditing(true);
    if (action === "doc-cancel" && confirmDiscard()) { document.getElementById("docs-editor").value = current.content; setEditing(false); }
    if (action === "doc-save") await saveCurrent();
    if (action === "doc-create") await createNew();
    if (action === "doc-rename") await renameCurrent();
    if (action === "doc-delete") await deleteCurrent();
    if (action === "doc-image") document.getElementById("docs-image-input").click();
}

async function loadTree(preferredPath) {
    const data = await ctx.api.request(`/admin/docs/${scope}`);
    documents = data.documents;
    document.getElementById("docs-tree").innerHTML = documents.map(item => `<button data-doc-path="${ctx.ui.escapeHtml(item.path)}"><strong>${ctx.ui.escapeHtml(item.title)}</strong><small>${ctx.ui.escapeHtml(item.path)}</small></button>`).join("");
    const path = preferredPath || (documents.some(item => item.path === current?.path) ? current.path : documents[0]?.path);
    if (path) await openDocument(path);
}

async function openDocument(path) {
    current = await ctx.api.request(`/admin/docs/${scope}/content?path=${encodeURIComponent(path)}`);
    dirty = false;
    document.getElementById("docs-editor").value = current.content;
    document.getElementById("docs-current-path").textContent = current.path;
    ctx.view.querySelectorAll("[data-doc-path]").forEach(button => button.classList.toggle("active", button.dataset.docPath === path));
    renderDocument();
    setEditing(false);
}

function setEditing(value) {
    editing = value;
    if (!value) dirty = false;
    document.getElementById("docs-content").hidden = value;
    document.getElementById("docs-editor").hidden = !value;
    ctx.view.querySelector(".docs-read-actions").hidden = value;
    ctx.view.querySelector(".docs-edit-actions").hidden = !value;
    if (value) document.getElementById("docs-editor").focus();
}

async function saveCurrent() {
    if (!current) return;
    try {
        current = await ctx.api.json(`/admin/docs/${scope}/content?path=${encodeURIComponent(current.path)}`, {method: "PUT", body: {content: document.getElementById("docs-editor").value, revision: current.revision}});
        dirty = false;
        ctx.toast("Документ сохранён", "success");
        await loadTree(current.path);
    } catch (error) { if (error.status === 409) ctx.toast("Файл изменён в другой вкладке. Обновите страницу.", "error"); else throw error; }
}

async function createNew() {
    const value = prompt("Путь нового файла, например раздел/начало-работы.md");
    if (!value) return;
    const path = value.toLowerCase().endsWith(".md") ? value : `${value}.md`;
    const created = await ctx.api.json(`/admin/docs/${scope}/content`, {method: "POST", body: {path}});
    await loadTree(created.path);
    setEditing(true);
}

async function renameCurrent() {
    if (!current || !confirmDiscard()) return;
    const value = prompt("Новый путь документа", current.path);
    if (!value || value === current.path) return;
    const newPath = value.toLowerCase().endsWith(".md") ? value : `${value}.md`;
    const renamed = await ctx.api.json(`/admin/docs/${scope}/content`, {method: "PATCH", body: {old_path: current.path, new_path: newPath}});
    await loadTree(renamed.path);
}

async function deleteCurrent() {
    if (!current || !confirm(`Удалить «${current.path}»?`)) return;
    await ctx.api.request(`/admin/docs/${scope}/content?path=${encodeURIComponent(current.path)}`, {method: "DELETE"});
    current = null; dirty = false; await loadTree();
}

async function uploadImage(event) {
    const file = event.target.files[0];
    if (!file || !current || !editing) return;
    const form = new FormData(); form.append("file", file);
    const result = await ctx.api.formData(`/admin/docs/${scope}/images`, form, {method: "POST"});
    const editor = document.getElementById("docs-editor");
    editor.setRangeText(result.markdown, editor.selectionStart, editor.selectionEnd, "end");
    editor.dispatchEvent(new Event("input")); event.target.value = "";
}

function renderDocument() {
    const content = document.getElementById("docs-content");
    content.innerHTML = window.DocsMarkdown.render(current?.content || "");
    window.DocsMarkdown.hydrateImages(content, `/admin/docs/${scope}/asset`, ctx.api.getSessionId());
}

function confirmDiscard() { return !dirty || confirm("Есть несохранённые изменения. Продолжить без сохранения?"); }
function warnUnsaved(event) { if (dirty) { event.preventDefault(); event.returnValue = ""; } }
