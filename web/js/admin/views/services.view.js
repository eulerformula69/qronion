let ctx;
let services = [];
let groups = [];
let draggedServiceId = null;
let draggedGroupId = null;

function serviceCount(count) {
    const last = count % 10;
    const teen = count % 100 >= 11 && count % 100 <= 14;
    return `${count} ${teen ? "услуг" : last === 1 ? "услуга" : last >= 2 && last <= 4 ? "услуги" : "услуг"}`;
}

export async function mount(context) {
    ctx = context;
    await load();
    render();
}

async function load() {
    const [serviceData, groupData] = await Promise.all([
        ctx.api.request("/services?limit=500&include_hidden=true"),
        ctx.api.request("/service-groups/")
    ]);
    services = Array.isArray(serviceData) ? serviceData : [];
    groups = Array.isArray(groupData) ? groupData : [];
}

function render() {
    ctx.view.innerHTML = `
        <div class="admin-toolbar">
            ${ctx.ui.button("Добавить услугу", {variant: "primary", action: "create-service"})}
            ${ctx.ui.button("Добавить группу", {variant: "secondary", action: "create-group"})}
        </div>
        <section class="admin-service-board">
            ${renderGroupSections()}
        </section>
    `;

    ctx.view.onclick = handleClick;
    ctx.view.ondragstart = handleDragStart;
    ctx.view.ondragover = handleDragOver;
    ctx.view.ondrop = handleDrop;
    ctx.view.ondragend = handleDragEnd;
}

function renderGroupSections() {
    const sections = [
        ...groups.map(group => ({
            id: group.id,
            name: group.name,
            isSystem: false,
            items: services.filter(service => service.service_group_id === group.id)
        })),
        {
            id: "",
            name: "Без группы",
            isSystem: true,
            items: services.filter(service => service.service_group_id === null || service.service_group_id === undefined)
        }
    ];

    return sections.map((section, index) => `
        <article class="admin-service-group" data-group-id="${section.id}">
            <header class="admin-service-group-header">
                <div class="admin-service-group-heading">
                    ${section.isSystem ? "" : `<span class="admin-group-drag-handle" draggable="true"
                        data-drag-group-id="${section.id}" title="Перетащить группу" aria-label="Перетащить группу">☰</span>`}
                    <div class="admin-service-group-copy">
                        <h2>${ctx.ui.escapeHtml(section.name)}</h2>
                        <span class="admin-service-group-count">${serviceCount(section.items.length)}</span>
                    </div>
                </div>
                ${section.isSystem ? "" : `
                    <div class="admin-service-group-actions">
                        ${ctx.ui.button("↑", {variant: "icon", action: "group-up", id: section.id, disabled: index === 0, title: "Группу выше"})}
                        ${ctx.ui.button("↓", {variant: "icon", action: "group-down", id: section.id, disabled: index === groups.length - 1, title: "Группу ниже"})}
                        ${ctx.ui.button("Переименовать", {variant: "secondary", action: "rename-group", id: section.id})}
                        ${ctx.ui.button("Удалить", {variant: "danger", action: "delete-group", id: section.id})}
                    </div>
                `}
            </header>
            <div class="admin-service-dropzone" data-group-id="${section.id}">
                ${section.items.length ? section.items.map(renderServiceCard).join("") : `
                    <div class="admin-service-empty">Перетащите сюда услугу</div>
                `}
            </div>
        </article>
    `).join("");
}

function renderServiceCard(service) {
    const availabilityLabel = service.status === "active" ? "Предоставляется" : "Не предоставляется";
    const terminalLabel = service.visible_on_terminal ? "Показывается на терминале" : "Скрыта на терминале";
    return `
        <div class="admin-service-item" draggable="true" data-service-id="${service.id}">
            <span class="admin-drag-handle" title="Перетащить">☰</span>
            <div class="admin-service-copy"><strong>${ctx.ui.escapeHtml(service.name)}</strong>
                <small>${terminalLabel} · ${service.operator_choice_enabled ? "С выбором оператора" : "Без выбора оператора"}</small>
            </div>
            ${ctx.ui.badge(availabilityLabel, service.status === "active" ? "success" : "neutral")}
            <span class="admin-service-actions">${ctx.ui.button("Редактировать", {variant: "link", action: "edit", id: service.id})}</span>
        </div>
    `;
}

async function handleClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const id = Number(button.dataset.id);

    if (button.dataset.action === "create-service") openCreateServiceDialog();
    if (button.dataset.action === "create-group") openCreateGroupDialog();
    if (button.dataset.action === "edit") openServiceDrawer(services.find(item => item.id === id));
    if (button.dataset.action === "rename-group") await renameGroup(id);
    if (button.dataset.action === "delete-group") await deleteGroup(id);
    if (button.dataset.action === "group-up") await moveGroup(id, -1);
    if (button.dataset.action === "group-down") await moveGroup(id, 1);
}

function groupOptions(selectedId) {
    return [
        {value: "", label: "Без группы"},
        ...groups.map(group => ({value: group.id, label: group.name}))
    ];
}

function createDialog(title, description, body, saveAction, saveLabel) {
    const dialog = document.createElement("dialog");
    dialog.className = "admin-service-dialog";
    dialog.innerHTML = `
        <form method="dialog">
            <div class="admin-service-dialog-heading">
                <div><h3>${title}</h3><p>${description}</p></div>
                <button class="admin-service-dialog-close" type="button" aria-label="Закрыть">×</button>
            </div>
            ${body}
            <div class="admin-service-dialog-actions">
                ${ctx.ui.button("Отмена", {variant: "secondary", action: "cancel-dialog"})}
                ${ctx.ui.button(saveLabel, {variant: "primary", action: saveAction, type: "submit"})}
            </div>
        </form>
    `;
    document.body.appendChild(dialog);
    dialog.addEventListener("close", () => dialog.remove());
    dialog.querySelector("form").onsubmit = event => event.preventDefault();
    dialog.querySelector(".admin-service-dialog-close").onclick = () => dialog.close();
    dialog.querySelector('[data-action="cancel-dialog"]').onclick = () => dialog.close();
    dialog.onclick = event => {
        if (event.target === dialog) dialog.close();
    };
    dialog.showModal();
    dialog.querySelector("input")?.focus();
    return dialog;
}

function openCreateServiceDialog() {
    const dialog = createDialog(
        "Новая услуга",
        "Укажите название и сразу выберите группу.",
        `<div class="admin-form">
            ${ctx.ui.field("Название", ctx.ui.input("name", "", "required autocomplete=\"off\""))}
            ${ctx.ui.field("Группа", ctx.ui.select("service_group_id", groupOptions(), ""))}
        </div>`,
        "save-new-service",
        "Добавить"
    );
    dialog.querySelector('[data-action="save-new-service"]').onclick = () => saveNewService(dialog);
}

async function saveNewService(dialog) {
    const data = Object.fromEntries(new FormData(dialog.querySelector("form")).entries());
    const name = data.name?.trim();
    if (!name) return ctx.toast("Введите название услуги", "error");
    await ctx.api.json("/services", {
        method: "POST",
        body: {
            name,
            operator_choice_enabled: false,
            operator_choice_allow_break: true,
            operator_choice_allow_offline: false,
            service_group_id: data.service_group_id ? Number(data.service_group_id) : null
        }
    });
    dialog.close();
    await load();
    render();
    ctx.view.querySelector('[data-action="create-service"]')?.focus();
    ctx.toast("Услуга добавлена", "success");
}

function openCreateGroupDialog() {
    const serviceChoices = services.length
        ? services.map(service => `
            <label class="admin-check-row">
                <input type="checkbox" name="service_ids" value="${service.id}">
                <span>${ctx.ui.escapeHtml(service.name)}</span>
            </label>`).join("")
        : '<p class="admin-service-dialog-empty">Услуг пока нет — группу можно заполнить позже.</p>';
    const dialog = createDialog(
        "Новая группа",
        "Назовите группу и выберите входящие в неё услуги.",
        `<div class="admin-form">
            ${ctx.ui.field("Название", ctx.ui.input("name", "", "required autocomplete=\"off\""))}
            <fieldset class="admin-service-choice-list"><legend>Услуги</legend>${serviceChoices}</fieldset>
        </div>`,
        "save-new-group",
        "Добавить"
    );
    dialog.querySelector('[data-action="save-new-group"]').onclick = () => saveNewGroup(dialog);
}

async function saveNewGroup(dialog) {
    const formData = new FormData(dialog.querySelector("form"));
    const name = formData.get("name")?.trim();
    if (!name) return ctx.toast("Введите название группы", "error");
    const group = await ctx.api.json("/service-groups", {method: "POST", body: {name}});
    const serviceIds = formData.getAll("service_ids").map(Number);
    await Promise.all(serviceIds.map(serviceId => ctx.api.json(`/services/${serviceId}/group`, {
        method: "PATCH",
        body: {service_group_id: group.id}
    })));
    dialog.close();
    await load();
    render();
    ctx.view.querySelector('[data-action="create-group"]')?.focus();
    ctx.toast("Группа добавлена", "success");
}

function openServiceDrawer(service = null) {
    const isEdit = Boolean(service);
    ctx.openDrawer(isEdit ? "Редактирование услуги" : "Новая услуга", `
        <form id="service-form" class="admin-form">
            ${ctx.ui.field("Название", ctx.ui.input("name", service?.name || "", "required"))}
            ${ctx.ui.field("Группа", ctx.ui.select("service_group_id", groupOptions(service?.service_group_id), service?.service_group_id ?? ""))}
            ${isEdit ? ctx.ui.field("Услуга предоставляется", ctx.ui.switchField("status_active", service.status === "active")) : ""}
            ${ctx.ui.field("Показывать на терминале", ctx.ui.switchField("visible_on_terminal", service?.visible_on_terminal ?? true))}
            ${ctx.ui.field("Выбор оператора", ctx.ui.switchField("operator_choice_enabled", service?.operator_choice_enabled ?? false))}
            <div data-operator-choice-options>
                ${ctx.ui.field("Разрешить выбирать оператора на перерыве", ctx.ui.switchField("operator_choice_allow_break", service?.operator_choice_allow_break ?? true))}
                ${ctx.ui.field("Разрешить выбирать оператора офлайн", ctx.ui.switchField("operator_choice_allow_offline", service?.operator_choice_allow_offline ?? false))}
            </div>
        </form>
    `, {
        footer: `
            ${ctx.ui.button("Отмена", {variant: "secondary", action: "close-service"})}
            ${isEdit ? ctx.ui.button("Удалить", {variant: "danger", action: "delete-service", id: service.id}) : ""}
            ${ctx.ui.button("Сохранить", {variant: "primary", action: "save-service", id: service?.id ?? ""})}
        `
    });

    document.getElementById("admin-drawer").onclick = handleDrawerClick;
    const choiceToggle = document.querySelector('[name="operator_choice_enabled"]');
    const choiceOptions = document.querySelector("[data-operator-choice-options]");
    const syncChoiceOptions = () => {
        if (choiceOptions) choiceOptions.hidden = !choiceToggle?.checked;
    };
    choiceToggle?.addEventListener("change", syncChoiceOptions);
    syncChoiceOptions();
}

async function handleDrawerClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    const id = Number(button.dataset.id);

    if (action === "close-service") ctx.closeDrawer();
    if (action === "save-service") await saveService(id || null);
    if (action === "delete-service") await deleteService(id);
}

async function saveService(id) {
    const saveButton = document.querySelector('[data-action="save-service"]');
    if (saveButton?.disabled) return;
    if (saveButton) saveButton.disabled = true;
    try {
        await persistService(id);
    } catch (error) {
        if (error?.name !== "ApiError") ctx.toast("Не удалось сохранить услугу. Попробуйте ещё раз", "error");
    } finally {
        if (saveButton?.isConnected) saveButton.disabled = false;
    }
}

async function persistService(id) {
    const form = document.getElementById("service-form");
    const data = Object.fromEntries(new FormData(form).entries());
    const name = data.name?.trim();
    if (!name) return ctx.toast("Введите название услуги", "error");
    const service_group_id = data.service_group_id ? Number(data.service_group_id) : null;

    if (!id) {
        await ctx.api.json("/services", {
            method: "POST",
            body: {
                name,
                operator_choice_enabled: Boolean(data.operator_choice_enabled),
                operator_choice_allow_break: Boolean(data.operator_choice_allow_break),
                operator_choice_allow_offline: Boolean(data.operator_choice_allow_offline),
                service_group_id
            }
        });
    } else {
        await ctx.api.json(`/services/${id}`, {
            method: "PATCH",
            body: {
                name,
                service_group_id,
                status: data.status_active ? "active" : "inactive",
                visible_on_terminal: Boolean(data.visible_on_terminal),
                operator_choice_enabled: Boolean(data.operator_choice_enabled),
                operator_choice_allow_break: Boolean(data.operator_choice_allow_break),
                operator_choice_allow_offline: Boolean(data.operator_choice_allow_offline)
            }
        });
    }

    ctx.closeDrawer();
    await load();
    render();
    ctx.view.querySelector(`[data-service-id="${id}"] [data-action="edit"]`)?.focus();
    ctx.toast("Услуга сохранена", "success");
}

async function deleteService(id) {
    if (!ctx.ui.confirmAction("Удалить услугу? Если по ней уже есть билеты, она будет скрыта, история сохранится.")) return;
    const data = await ctx.api.request(`/services/${id}`, {method: "DELETE"});
    if (data.message) ctx.toast(data.message, "info");
    ctx.closeDrawer();
    await load();
    render();
}

async function renameGroup(id) {
    const group = groups.find(item => item.id === id);
    const name = prompt("Название группы", group?.name || "")?.trim();
    if (!name) return;
    await ctx.api.json(`/service-groups/${id}`, {method: "PATCH", body: {name}});
    await load();
    render();
}

async function deleteGroup(id) {
    if (!ctx.ui.confirmAction("Удалить группу? Услуги останутся без группы.")) return;
    await ctx.api.request(`/service-groups/${id}`, {method: "DELETE"});
    await load();
    render();
}

async function moveGroup(id, direction) {
    const index = groups.findIndex(item => item.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= groups.length) return;
    const reordered = [...groups];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    await ctx.api.json("/service-groups/order", {method: "PUT", body: {group_ids: reordered.map(item => item.id)}});
    await load();
    render();
}

function handleDragStart(event) {
    const groupHandle = event.target.closest("[data-drag-group-id]");
    if (groupHandle) {
        draggedGroupId = Number(groupHandle.dataset.dragGroupId);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `group:${draggedGroupId}`);
        groupHandle.closest(".admin-service-group")?.classList.add("dragging");
        return;
    }
    const item = event.target.closest(".admin-service-item");
    if (!item) return;
    draggedServiceId = Number(item.dataset.serviceId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(draggedServiceId));
    item.classList.add("dragging");
}

function handleDragOver(event) {
    if (draggedGroupId) {
        event.preventDefault();
        const target = event.target.closest('.admin-service-group[data-group-id]:not([data-group-id=""])');
        const dragged = ctx.view.querySelector(`.admin-service-group[data-group-id="${draggedGroupId}"]`);
        if (!target || !dragged || target === dragged) return;
        const box = target.getBoundingClientRect();
        target.parentNode.insertBefore(dragged, event.clientY < box.top + box.height / 2 ? target : target.nextSibling);
        return;
    }
    const dropzone = event.target.closest(".admin-service-dropzone");
    if (!dropzone || !draggedServiceId) return;
    event.preventDefault();
    const dragged = ctx.view.querySelector(`.admin-service-item[data-service-id="${draggedServiceId}"]`);
    if (!dragged) return;
    const afterElement = getDragAfterElement(dropzone, event.clientY);
    if (afterElement) {
        dropzone.insertBefore(dragged, afterElement);
    } else {
        dropzone.appendChild(dragged);
    }
}

async function handleDrop(event) {
    if (draggedGroupId) {
        event.preventDefault();
        await persistGroupOrder();
        return;
    }
    const dropzone = event.target.closest(".admin-service-dropzone");
    if (!dropzone || !draggedServiceId) return;
    event.preventDefault();
    await persistDraggedOrder();
}

function handleDragEnd() {
    ctx.view.querySelectorAll(".dragging").forEach(item => item.classList.remove("dragging"));
    draggedServiceId = null;
    draggedGroupId = null;
}

async function persistGroupOrder() {
    const groupIds = [...ctx.view.querySelectorAll('.admin-service-group[data-group-id]:not([data-group-id=""])')]
        .map(item => Number(item.dataset.groupId));
    if (groupIds.length !== groups.length) return render();
    await ctx.api.json("/service-groups/order", {method: "PUT", body: {group_ids: groupIds}});
    await load();
    render();
    ctx.toast("Порядок групп сохранён", "success");
}

function getDragAfterElement(container, y) {
    const elements = [...container.querySelectorAll(".admin-service-item:not(.dragging)")];
    return elements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return {offset, element: child};
        }
        return closest;
    }, {offset: Number.NEGATIVE_INFINITY, element: null}).element;
}

async function persistDraggedOrder() {
    const groupUpdates = [];
    const orderedIds = [];

    ctx.view.querySelectorAll(".admin-service-group").forEach(groupEl => {
        const groupValue = groupEl.dataset.groupId;
        const groupId = groupValue ? Number(groupValue) : null;
        groupEl.querySelectorAll(".admin-service-item").forEach(item => {
            const serviceId = Number(item.dataset.serviceId);
            orderedIds.push(serviceId);
            const service = services.find(current => current.id === serviceId);
            if (service && (service.service_group_id ?? null) !== groupId) {
                groupUpdates.push(ctx.api.json(`/services/${serviceId}/group`, {
                    method: "PATCH",
                    body: {service_group_id: groupId}
                }));
            }
        });
    });

    if (orderedIds.length !== services.length) {
        await load();
        render();
        return;
    }

    await Promise.all(groupUpdates);
    await ctx.api.json("/services/order", {method: "PUT", body: {service_ids: orderedIds}});
    await load();
    render();
    ctx.toast("Порядок услуг сохранён", "success");
}
