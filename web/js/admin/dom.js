export function resetOpened() {
    document.querySelectorAll(".admin-drawer.open").forEach(drawer => drawer.classList.remove("open"));
}

export function setTable(html) {
    const table = document.getElementById("table");
    if (table) table.innerHTML = html;
}

export function setForm(html) {
    const form = document.getElementById("form");
    if (form) form.innerHTML = html;
}

export function setActiveTab(tabId) {
    document.querySelectorAll(".admin-nav-link").forEach(link => {
        link.classList.toggle("active", link.getAttribute("href") === `#${tabId.replace("tab-", "")}`);
    });
}
