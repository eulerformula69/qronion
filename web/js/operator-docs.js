(function () {
    async function request(path) {
        const response = await fetch(`${CONFIG.API_URL}${path}`, {headers: {"session-id": sessionStorage.getItem("session_id")}});
        if (!response.ok) throw new Error("Не удалось загрузить документацию");
        return response.json();
    }
    async function openOperatorDocumentation() {
        if (typeof closeOperatorSettingsPopup === "function") closeOperatorSettingsPopup();
        document.querySelector(".operator-docs-overlay")?.remove();
        const overlay = document.createElement("div");
        overlay.className = "operator-docs-overlay";
        overlay.innerHTML = `<section class="operator-docs-dialog" role="dialog" aria-modal="true"><header><h2>Инструкция оператора</h2><button type="button" data-docs-close aria-label="Закрыть">×</button></header><div class="operator-docs-layout"><nav class="operator-docs-tree">Загрузка...</nav><article class="operator-docs-content">Загрузка...</article></div></section>`;
        document.body.appendChild(overlay);
        overlay.addEventListener("click", event => {
            if (event.target === overlay || event.target.closest("[data-docs-close]")) overlay.remove();
            const button = event.target.closest("[data-doc-path]");
            if (button) loadDocument(overlay, button.dataset.docPath);
        });
        try {
            const data = await request("/operator/docs");
            overlay.querySelector(".operator-docs-tree").innerHTML = data.documents.map(item => `<button type="button" data-doc-path="${escapeHtml(item.path)}"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.path)}</small></button>`).join("");
            if (data.documents[0]) await loadDocument(overlay, data.documents[0].path);
            else overlay.querySelector(".operator-docs-content").textContent = "Документация пока не заполнена";
        } catch (error) { overlay.querySelector(".operator-docs-content").textContent = error.message; }
    }
    async function loadDocument(overlay, path) {
        overlay.querySelectorAll("[data-doc-path]").forEach(button => button.classList.toggle("active", button.dataset.docPath === path));
        const content = overlay.querySelector(".operator-docs-content");
        content.textContent = "Загрузка...";
        const data = await request(`/operator/docs/content?path=${encodeURIComponent(path)}`);
        content.innerHTML = window.DocsMarkdown.render(data.content);
        window.DocsMarkdown.hydrateImages(content, `${CONFIG.API_URL}/operator/docs/asset`, sessionStorage.getItem("session_id"));
    }
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]); }
    window.openOperatorDocumentation = openOperatorDocumentation;
})();
