(function () {
    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
    }

    function inline(value) {
        let text = escapeHtml(value);
        text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
        text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, path) => `<img alt="${alt}" data-doc-image="${escapeHtml(path)}">`);
        text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
        return text;
    }

    function render(markdown) {
        const lines = String(markdown || "").replace(/\r/g, "").split("\n");
        const html = [];
        let paragraph = [];
        let list = null;
        let code = null;

        const flushParagraph = () => {
            if (paragraph.length) html.push(`<p>${inline(paragraph.join(" "))}</p>`);
            paragraph = [];
        };
        const flushList = () => {
            if (list) html.push(`<${list.type}>${list.items.map(item => `<li>${inline(item)}</li>`).join("")}</${list.type}>`);
            list = null;
        };

        lines.forEach(line => {
            if (line.startsWith("```")) {
                flushParagraph(); flushList();
                if (code === null) code = [];
                else { html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = null; }
                return;
            }
            if (code !== null) { code.push(line); return; }
            const heading = line.match(/^(#{1,4})\s+(.+)$/);
            const unordered = line.match(/^\s*[-*]\s+(.+)$/);
            const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
            if (heading) {
                flushParagraph(); flushList();
                const level = heading[1].length;
                html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            } else if (unordered || ordered) {
                flushParagraph();
                const type = unordered ? "ul" : "ol";
                if (list?.type !== type) { flushList(); list = {type, items: []}; }
                list.items.push((unordered || ordered)[1]);
            } else if (line.startsWith("> ")) {
                flushParagraph(); flushList(); html.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
            } else if (!line.trim()) {
                flushParagraph(); flushList();
            } else {
                paragraph.push(line.trim());
            }
        });
        flushParagraph(); flushList();
        if (code !== null) html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        return html.join("");
    }

    async function hydrateImages(container, assetUrl, sessionId) {
        await Promise.all(Array.from(container.querySelectorAll("img[data-doc-image]")).map(async image => {
            const path = image.dataset.docImage;
            if (/^(https?:|data:)/i.test(path)) { image.src = path; return; }
            try {
                const response = await fetch(`${assetUrl}?path=${encodeURIComponent(path)}`, {headers: {"session-id": sessionId}});
                if (!response.ok) throw new Error("image");
                image.src = URL.createObjectURL(await response.blob());
            } catch { image.replaceWith(Object.assign(document.createElement("span"), {textContent: `[Изображение недоступно: ${path}]`})); }
        }));
    }

    window.DocsMarkdown = {render, hydrateImages};
})();
