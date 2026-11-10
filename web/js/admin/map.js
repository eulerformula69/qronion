import { fetchJSON, readResponseData } from "./api.js";
import { resetOpened, setActiveTab, setForm, setTable } from "./dom.js";

const API = CONFIG.API_URL;

//////// КАРТА
let officeMap = {version: 1, width: 1200, height: 700, objects: []};
let selectedMapObjectId = null;
let selectedMapObjectIds = new Set();
let mapWindows = [];
let mapOperators = [];
let mapServices = [];
let mapWindowServices = {};
let mapDirty = false;
let mapZoom = 1;
let mapWorldWidth = 6000;
let mapWorldHeight = 4000;
const MAP_GRID_SIZE = 20;
let mapSnapEnabled = localStorage.getItem("map_snap_enabled") === "true";
let mapUndoStack = [];
let mapRedoStack = [];
let mapClipboard = [];
let mapSearchQuery = "";
let mapStatusFilter = "all";
let mapOperatorFilter = "all";
let mapServiceFilter = "all";
let mapSmartGuides = [];

export async function mapRequest(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            "session-id": sessionStorage.getItem("session_id")
        }
    });
    const data = await readResponseData(response);
    if (!response.ok) throw new Error(data.detail || "Ошибка работы с картой");
    return data;
}

export async function loadMapEditor() {
    resetOpened();
    document.getElementById("form").style.display = "block";
    document.getElementById("table").style.display = "none";
    setTable("");
    document.getElementById("stats-container")?.remove();
    setActiveTab("tab-map");

    setForm(`<div class="map-loading">Загрузка карты...</div>`);
    try {
        const [loadedMap, loadedWindows, loadedOperators, loadedServices, loadedLinks] = await Promise.all([
            mapRequest(`${API}/admin/map`),
            fetchJSON(`${API}/windows/?limit=500`),
            fetchJSON(`${API}/operators/?limit=500`),
            fetchJSON(`${API}/services/?limit=500&include_hidden=true`),
            fetchJSON(`${API}/window-services/?limit=500`)
        ]);
        officeMap = loadedMap;
        mapWindows = loadedWindows;
        mapOperators = loadedOperators;
        mapServices = loadedServices;
        if (!Array.isArray(mapWindows)) mapWindows = [];
        if (!Array.isArray(mapOperators)) mapOperators = [];
        if (!Array.isArray(mapServices)) mapServices = [];
        mapWindowServices = {};
        if (Array.isArray(loadedLinks)) {
            loadedLinks.forEach(link => {
                (mapWindowServices[link.window_id] ||= []).push(link);
            });
        }
        mapWorldWidth = Math.max(6000, officeMap.width);
        mapWorldHeight = Math.max(4000, officeMap.height);
        mapZoom = 1;
        selectedMapObjectId = null;
        selectedMapObjectIds = new Set();
        mapUndoStack = [];
        mapRedoStack = [];
        mapClipboard = [];
        mapDirty = false;
        renderMapEditor();
    } catch (error) {
        setForm(`<div class="map-error">${escapeMapHtml(error.message)}</div>`);
    }
}

export function renderMapEditor() {
    setForm(`
        <div class="map-editor">
            <div class="map-toolbar">
                <button class="map-tool-room" onclick="addMapObject('room')">Добавить помещение</button>
                <button class="map-tool-workplace" onclick="addMapObject('workplace')">Добавить физический стол</button>
                <details class="map-tools-menu">
                    <summary>Другие объекты</summary>
                    <div class="map-tools-popover">
                        <button onclick="addMapObject('wall')">Стена</button>
                        <button onclick="addMapObject('door')">Дверь</button>
                        <button onclick="addMapObject('label')">Подпись</button>
                        <button onclick="addMapObject('zone')">Зона</button>
                    </div>
                </details>
                <select class="map-template-select" onchange="applyMapTemplate(this.value); this.value=''">
                    <option value="">Шаблоны размеров</option>
                    <option value="room-small">Помещение 400 × 300</option>
                    <option value="room-large">Помещение 800 × 600</option>
                    <option value="workplace">Стол 120 × 80</option>
                    <option value="wall-horizontal">Стена 400 × 12</option>
                    <option value="wall-vertical">Стена 12 × 400</option>
                </select>
                <div class="map-zoom-controls">
                    <button title="Отдалить" onclick="changeMapZoom(-0.15)">−</button>
                    <button id="map-zoom-value" class="map-zoom-value" title="Вернуть масштаб 100%" onclick="resetMapZoom()">100%</button>
                    <button title="Приблизить" onclick="changeMapZoom(0.15)">+</button>
                </div>
                <label class="map-snap-toggle">
                    <input type="checkbox" ${mapSnapEnabled ? "checked" : ""}
                        onchange="toggleMapSnap(this.checked)">
                    <span>Привязка к сетке</span>
                </label>
                <button title="Отменить (Ctrl+Z)" onclick="undoMapChange()">↶</button>
                <button title="Повторить (Ctrl+Y)" onclick="redoMapChange()">↷</button>
                <details class="map-tools-menu">
                    <summary>Выравнивание</summary>
                    <div class="map-tools-popover map-align-popover">
                        <button onclick="alignMapSelection('left')">По левому краю</button>
                        <button onclick="alignMapSelection('center')">По центру</button>
                        <button onclick="alignMapSelection('top')">По верхнему краю</button>
                        <button onclick="alignMapSelection('middle')">По середине</button>
                        <button onclick="distributeMapSelection('horizontal')">Интервалы по горизонтали</button>
                        <button onclick="distributeMapSelection('vertical')">Интервалы по вертикали</button>
                    </div>
                </details>
                <button title="Показать всё" onclick="fitMapContent()">Вся карта</button>
                <button title="Показать выбранное" onclick="focusMapSelection()">К выбранному</button>
                <span class="map-toolbar-spacer"></span>
                <span id="map-save-state" class="map-save-state">Все изменения сохранены</span>
                <button class="map-save-button" onclick="saveOfficeMap()">Сохранить карту</button>
            </div>
            <div class="map-filterbar">
                <input id="map-search" type="search" name="map_object_search"
                    role="searchbox" autocomplete="off" autocapitalize="off" spellcheck="false"
                    data-lpignore="true" data-1p-ignore="true"
                    placeholder="Поиск стола, рабочего места или оператора"
                    oninput="setMapSearch(this.value)">
                <select onchange="setMapStatusFilter(this.value)">
                    <option value="all">Все статусы</option>
                    <option value="online">Онлайн</option>
                    <option value="break">Перерыв</option>
                    <option value="offline">Офлайн</option>
                    <option value="unconfigured">Не настроено</option>
                    <option value="conflict">Конфликты</option>
                </select>
                <select onchange="setMapOperatorFilter(this.value)">
                    <option value="all">Все операторы</option>
                    ${mapOperators.map(item => `<option value="${item.id}">${escapeMapHtml(item.name)}</option>`).join("")}
                </select>
                <select onchange="setMapServiceFilter(this.value)">
                    <option value="all">Все услуги</option>
                    ${mapServices.map(item => `<option value="${item.id}">${escapeMapHtml(item.name)}</option>`).join("")}
                </select>
                <span class="map-filter-hint">Shift + клик или Shift + рамка — множественный выбор</span>
            </div>
            <div class="map-editor-body">
                <div id="map-viewport" class="map-canvas-scroll">
                    <div id="map-canvas-stage" class="map-canvas-stage">
                        <div id="map-canvas" class="map-canvas"></div>
                    </div>
                </div>
                <aside id="map-properties" class="map-properties"></aside>
            </div>
            <div id="map-minimap" class="map-minimap" title="Навигация по карте"></div>
        </div>
    `);

    const canvas = document.getElementById("map-canvas");
    initializeMapViewport();
    renderMapObjects();
    renderMapProperties();
    renderMapMinimap();
    updateMapSaveState();
    document.removeEventListener("keydown", handleMapKeyboard);
    document.addEventListener("keydown", handleMapKeyboard);
}

export function initializeMapViewport() {
    updateMapSurfaceSize();
    const viewport = document.getElementById("map-viewport");
    const canvas = document.getElementById("map-canvas");

    viewport.addEventListener("wheel", event => {
        event.preventDefault();
        setMapZoom(mapZoom + (event.deltaY < 0 ? 0.12 : -0.12), event.clientX, event.clientY);
    }, {passive: false});
    viewport.addEventListener("scroll", renderMapMinimap, {passive: true});

    viewport.addEventListener("pointerdown", event => {
        if (event.button === 0 && event.shiftKey && event.target === canvas) {
            startMapMarquee(event, viewport, canvas);
            return;
        }
        const panRequested = event.button === 1 || (event.button === 0 && event.target === canvas);
        if (!panRequested) return;
        event.preventDefault();
        if (event.button === 0) selectMapObject(null);
        const startX = event.clientX;
        const startY = event.clientY;
        const startLeft = viewport.scrollLeft;
        const startTop = viewport.scrollTop;
        viewport.classList.add("panning");
        viewport.setPointerCapture(event.pointerId);

        const move = moveEvent => {
            viewport.scrollLeft = startLeft - (moveEvent.clientX - startX);
            viewport.scrollTop = startTop - (moveEvent.clientY - startY);
        };
        const stop = () => {
            viewport.classList.remove("panning");
            viewport.removeEventListener("pointermove", move);
        };
        viewport.addEventListener("pointermove", move);
        viewport.addEventListener("pointerup", stop, {once: true});
        viewport.addEventListener("pointercancel", stop, {once: true});
    });
}

export function startMapMarquee(event, viewport, canvas) {
    event.preventDefault();
    const canvasRect = canvas.getBoundingClientRect();
    const startX = (event.clientX - canvasRect.left) / mapZoom;
    const startY = (event.clientY - canvasRect.top) / mapZoom;
    const marquee = document.createElement("div");
    marquee.className = "map-selection-marquee";
    canvas.appendChild(marquee);
    viewport.setPointerCapture(event.pointerId);

    const move = moveEvent => {
        const currentX = (moveEvent.clientX - canvasRect.left) / mapZoom;
        const currentY = (moveEvent.clientY - canvasRect.top) / mapZoom;
        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);
        Object.assign(marquee.style, {left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`});
        selectedMapObjectIds = new Set(officeMap.objects.filter(item =>
            item.x < left + width && item.x + item.width > left &&
            item.y < top + height && item.y + item.height > top
        ).map(item => item.id));
        selectedMapObjectId = [...selectedMapObjectIds][0] || null;
        document.querySelectorAll(".map-object").forEach(element => {
            element.classList.toggle("selected", selectedMapObjectIds.has(element.dataset.objectId));
        });
    };
    const stop = () => {
        marquee.remove();
        viewport.removeEventListener("pointermove", move);
        renderMapProperties();
    };
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", stop, {once: true});
    viewport.addEventListener("pointercancel", stop, {once: true});
}

export function updateMapSurfaceSize() {
    const canvas = document.getElementById("map-canvas");
    const stage = document.getElementById("map-canvas-stage");
    if (!canvas || !stage) return;
    canvas.style.width = `${mapWorldWidth}px`;
    canvas.style.height = `${mapWorldHeight}px`;
    canvas.style.transform = `scale(${mapZoom})`;
    stage.style.width = `${mapWorldWidth * mapZoom}px`;
    stage.style.height = `${mapWorldHeight * mapZoom}px`;
    const value = document.getElementById("map-zoom-value");
    if (value) value.textContent = `${Math.round(mapZoom * 100)}%`;
}

export function setMapZoom(value, clientX, clientY) {
    const viewport = document.getElementById("map-viewport");
    const stage = document.getElementById("map-canvas-stage");
    if (!viewport || !stage) return;
    const nextZoom = Math.max(0.25, Math.min(2.5, Math.round(value * 100) / 100));
    if (nextZoom === mapZoom) return;

    const rect = viewport.getBoundingClientRect();
    const anchorX = clientX === undefined ? viewport.clientWidth / 2 : clientX - rect.left;
    const anchorY = clientY === undefined ? viewport.clientHeight / 2 : clientY - rect.top;
    const worldX = (viewport.scrollLeft + anchorX - stage.offsetLeft) / mapZoom;
    const worldY = (viewport.scrollTop + anchorY - stage.offsetTop) / mapZoom;
    mapZoom = nextZoom;
    updateMapSurfaceSize();
    viewport.scrollLeft = stage.offsetLeft + worldX * mapZoom - anchorX;
    viewport.scrollTop = stage.offsetTop + worldY * mapZoom - anchorY;
}

export function changeMapZoom(delta) {
    setMapZoom(mapZoom + delta);
}

export function resetMapZoom() {
    setMapZoom(1);
}

export function toggleMapSnap(enabled) {
    mapSnapEnabled = enabled;
    localStorage.setItem("map_snap_enabled", String(enabled));
}

export function snapMapValue(value) {
    return mapSnapEnabled ? Math.round(value / MAP_GRID_SIZE) * MAP_GRID_SIZE : value;
}

export function captureMapState() {
    return JSON.stringify({objects: officeMap.objects, width: mapWorldWidth, height: mapWorldHeight});
}

export function pushMapHistory() {
    mapUndoStack.push(captureMapState());
    if (mapUndoStack.length > 100) mapUndoStack.shift();
    mapRedoStack = [];
}

export function restoreMapState(snapshot) {
    const state = JSON.parse(snapshot);
    officeMap.objects = state.objects;
    mapWorldWidth = state.width;
    mapWorldHeight = state.height;
    selectedMapObjectIds = new Set(
        [...selectedMapObjectIds].filter(id => officeMap.objects.some(item => item.id === id))
    );
    selectedMapObjectId = [...selectedMapObjectIds][0] || null;
    updateMapSurfaceSize();
    markMapDirty();
    renderMapObjects();
    renderMapProperties();
    renderMapMinimap();
}

export function undoMapChange() {
    if (!mapUndoStack.length) return;
    mapRedoStack.push(captureMapState());
    restoreMapState(mapUndoStack.pop());
}

export function redoMapChange() {
    if (!mapRedoStack.length) return;
    mapUndoStack.push(captureMapState());
    restoreMapState(mapRedoStack.pop());
}

export function getSelectedMapObjects() {
    return officeMap.objects.filter(item => selectedMapObjectIds.has(item.id));
}

export function copyMapSelection() {
    mapClipboard = getSelectedMapObjects().map(item => structuredClone(item));
}

export function pasteMapSelection() {
    if (!mapClipboard.length) return;
    pushMapHistory();
    const copies = mapClipboard.map(item => ({
        ...structuredClone(item),
        id: createMapObjectId(),
        x: clampMapValue(item.x + 30, 0, mapWorldWidth - item.width),
        y: clampMapValue(item.y + 30, 0, mapWorldHeight - item.height)
    }));
    officeMap.objects.push(...copies);
    selectedMapObjectIds = new Set(copies.map(item => item.id));
    selectedMapObjectId = copies[0]?.id || null;
    mapClipboard = copies.map(item => structuredClone(item));
    markMapDirty();
    renderMapObjects();
    renderMapProperties();
    renderMapMinimap();
}

export function duplicateMapSelection() {
    copyMapSelection();
    pasteMapSelection();
}

export function handleMapKeyboard(event) {
    if (!document.getElementById("map-canvas")) return;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName) || event.target.isContentEditable;
    if (typing && event.key !== "Escape") return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        event.shiftKey ? redoMapChange() : undoMapChange();
    } else if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault(); redoMapChange();
    } else if ((event.ctrlKey || event.metaKey) && key === "c") {
        event.preventDefault(); copyMapSelection();
    } else if ((event.ctrlKey || event.metaKey) && key === "v") {
        event.preventDefault(); pasteMapSelection();
    } else if ((event.ctrlKey || event.metaKey) && key === "d") {
        event.preventDefault(); duplicateMapSelection();
    } else if ((event.key === "Delete" || event.key === "Backspace") && selectedMapObjectIds.size) {
        event.preventDefault(); deleteSelectedMapObject();
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        const step = event.shiftKey ? MAP_GRID_SIZE : 1;
        const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
        const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
        moveMapSelection(dx, dy);
    } else if (event.key === "Escape") {
        selectMapObject(null);
    }
}

export function moveMapSelection(dx, dy) {
    const objects = getSelectedMapObjects();
    if (!objects.length) return;
    pushMapHistory();
    objects.forEach(item => {
        item.x = clampMapValue(item.x + dx, 0, mapWorldWidth - item.width);
        item.y = clampMapValue(item.y + dy, 0, mapWorldHeight - item.height);
    });
    markMapDirty();
    renderMapObjects();
    renderMapProperties();
}

export function alignMapSelection(mode) {
    const objects = getSelectedMapObjects();
    if (objects.length < 2) return;
    pushMapHistory();
    const left = Math.min(...objects.map(item => item.x));
    const top = Math.min(...objects.map(item => item.y));
    const right = Math.max(...objects.map(item => item.x + item.width));
    const bottom = Math.max(...objects.map(item => item.y + item.height));
    objects.forEach(item => {
        if (mode === "left") item.x = left;
        if (mode === "center") item.x = Math.round((left + right - item.width) / 2);
        if (mode === "top") item.y = top;
        if (mode === "middle") item.y = Math.round((top + bottom - item.height) / 2);
    });
    markMapDirty(); renderMapObjects(); renderMapProperties();
}

export function distributeMapSelection(direction) {
    const objects = getSelectedMapObjects();
    if (objects.length < 3) return;
    pushMapHistory();
    if (direction === "horizontal") {
        objects.sort((a, b) => a.x - b.x);
        const total = objects.reduce((sum, item) => sum + item.width, 0);
        const gap = (objects.at(-1).x + objects.at(-1).width - objects[0].x - total) / (objects.length - 1);
        let x = objects[0].x;
        objects.forEach(item => { item.x = Math.round(x); x += item.width + gap; });
    } else {
        objects.sort((a, b) => a.y - b.y);
        const total = objects.reduce((sum, item) => sum + item.height, 0);
        const gap = (objects.at(-1).y + objects.at(-1).height - objects[0].y - total) / (objects.length - 1);
        let y = objects[0].y;
        objects.forEach(item => { item.y = Math.round(y); y += item.height + gap; });
    }
    markMapDirty(); renderMapObjects(); renderMapProperties();
}

export function renderMapObjects() {
    const canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    canvas.innerHTML = "";

    const layerOrder = {zone: 0, room: 1, wall: 2, door: 3, workplace: 4, label: 5};
    const objects = [...officeMap.objects].sort((a, b) => layerOrder[a.type] - layerOrder[b.type]);
    const windowUsage = getMapWindowUsage();

    for (const object of objects) {
        const element = document.createElement("div");
        element.className = `map-object map-${object.type}`;
        if (selectedMapObjectIds.has(object.id)) element.classList.add("selected");
        if (!mapObjectMatchesFilters(object, windowUsage)) element.classList.add("map-filtered-out");
        const status = getMapObjectStatus(object, windowUsage);
        if (status) element.classList.add(`map-status-${status}`);
        element.dataset.objectId = object.id;
        element.style.left = `${object.x}px`;
        element.style.top = `${object.y}px`;
        element.style.width = `${object.width}px`;
        element.style.height = `${object.height}px`;

        const title = document.createElement("span");
        title.className = "map-object-title";
        title.textContent = mapObjectTitle(object);
        element.appendChild(title);

        if (object.type === "workplace" && object.window_id) {
            const operator = mapOperators.find(item => item.window_id === object.window_id);
            const links = mapWindowServices[object.window_id] || [];
            const subtitle = document.createElement("span");
            subtitle.className = "map-object-subtitle";
            subtitle.textContent = [operator?.name, links.length ? `${links.length} усл.` : null].filter(Boolean).join(" · ");
            element.appendChild(subtitle);
        }

        const resizeHandle = document.createElement("span");
        resizeHandle.className = "map-resize-handle";
        resizeHandle.title = "Изменить размер";
        resizeHandle.addEventListener("pointerdown", event => startMapResize(event, object));
        element.appendChild(resizeHandle);

        element.addEventListener("pointerdown", event => startMapDrag(event, object));
        canvas.appendChild(element);
    }
    renderMapGuides();
    renderMapMinimap();
}

export function getMapWindowUsage() {
    const usage = new Map();
    officeMap.objects.filter(item => item.type === "workplace" && item.window_id).forEach(item => {
        usage.set(item.window_id, (usage.get(item.window_id) || 0) + 1);
    });
    return usage;
}

export function getMapObjectStatus(object, usage = getMapWindowUsage()) {
    if (object.type !== "workplace") return null;
    if (!object.window_id || !mapWindows.some(item => item.id === object.window_id)) return "unconfigured";
    if ((usage.get(object.window_id) || 0) > 1) return "conflict";
    return mapWindows.find(item => item.id === object.window_id)?.status || "offline";
}

export function mapObjectMatchesFilters(object, usage) {
    if (mapStatusFilter !== "all" && getMapObjectStatus(object, usage) !== mapStatusFilter) return false;
    if (mapOperatorFilter !== "all") {
        const operator = mapOperators.find(item => item.id === Number(mapOperatorFilter));
        if (object.window_id !== operator?.window_id) return false;
    }
    if (mapServiceFilter !== "all") {
        const hasService = (mapWindowServices[object.window_id] || []).some(link => link.service_id === Number(mapServiceFilter));
        if (!hasService) return false;
    }
    if (!mapSearchQuery) return true;
    const windowItem = mapWindows.find(item => item.id === object.window_id);
    const operator = mapOperators.find(item => item.window_id === object.window_id);
    const serviceNames = (mapWindowServices[object.window_id] || []).map(link =>
        mapServices.find(service => service.id === link.service_id)?.name || ""
    );
    return [object.label, windowItem?.name, operator?.name, ...serviceNames]
        .some(value => String(value || "").toLowerCase().includes(mapSearchQuery));
}

export function setMapSearch(value) {
    mapSearchQuery = value.trim().toLowerCase();
    renderMapObjects();
}

export function setMapStatusFilter(value) {
    mapStatusFilter = value;
    renderMapObjects();
}

export function setMapOperatorFilter(value) {
    mapOperatorFilter = value;
    renderMapObjects();
}

export function setMapServiceFilter(value) {
    mapServiceFilter = value;
    renderMapObjects();
}

export function mapObjectTitle(object) {
    if (object.type === "room") return object.label || "Помещение";
    if (object.type === "workplace") {
        const windowItem = mapWindows.find(item => item.id === object.window_id);
        return object.label || windowItem?.name || "Физический стол";
    }
    const defaults = {wall: "Стена", door: "Дверь", label: "Подпись", zone: "Зона"};
    return object.label || defaults[object.type] || "Объект";
}

export function addMapObject(type) {
    pushMapHistory();
    const sameTypeCount = officeMap.objects.filter(item => item.type === type).length;
    const presets = {
        room: [420, 260, "Помещение"], workplace: [100, 70, "Физический стол"],
        wall: [400, 12, "Стена"], door: [80, 16, "Дверь"],
        label: [180, 40, "Подпись"], zone: [300, 220, "Зона"]
    };
    const [width, height, defaultLabel] = presets[type];
    const offset = (sameTypeCount * 24) % 240;
    const object = {
        id: createMapObjectId(),
        type,
        x: snapMapValue(Math.min(40 + offset, mapWorldWidth - width)),
        y: snapMapValue(Math.min(40 + offset, mapWorldHeight - height)),
        width,
        height,
        label: `${defaultLabel} ${sameTypeCount + 1}`,
        window_id: null
    };
    officeMap.objects.push(object);
    selectedMapObjectId = object.id;
    selectedMapObjectIds = new Set([object.id]);
    markMapDirty();
    renderMapObjects();
    renderMapProperties();
}

export function createMapObjectId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `map-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function selectMapObject(id) {
    selectedMapObjectId = id;
    selectedMapObjectIds = id ? new Set([id]) : new Set();
    renderMapObjects();
    renderMapProperties();
}

export function startMapDrag(event, object) {
    if (event.button !== 0 || event.target.classList.contains("map-resize-handle")) return;
    event.preventDefault();
    selectMapObjectFromPointer(object.id, event.shiftKey);
    if (!selectedMapObjectIds.has(object.id)) return;
    pushMapHistory();
    const startX = event.clientX;
    const startY = event.clientY;
    const movingObjects = getSelectedMapObjects();
    const origins = new Map(movingObjects.map(item => [item.id, {x: item.x, y: item.y}]));
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = moveEvent => {
        const dx = (moveEvent.clientX - startX) / mapZoom;
        const dy = (moveEvent.clientY - startY) / mapZoom;
        movingObjects.forEach(item => {
            const origin = origins.get(item.id);
            item.x = clampMapValue(snapMapValue(origin.x + dx), 0, mapWorldWidth - item.width);
            item.y = clampMapValue(snapMapValue(origin.y + dy), 0, mapWorldHeight - item.height);
            ensureMapWorldSpace(item);
            const element = document.querySelector(`[data-object-id="${item.id}"]`);
            if (element) { element.style.left = `${item.x}px`; element.style.top = `${item.y}px`; }
        });
        if (movingObjects.length === 1) updateMapSmartGuides(object);
        markMapDirty();
    };
    const stop = () => {
        target.removeEventListener("pointermove", move);
        mapSmartGuides = [];
        renderMapObjects();
        renderMapProperties();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop, {once: true});
    target.addEventListener("pointercancel", stop, {once: true});
}

export function startMapResize(event, object) {
    event.preventDefault();
    event.stopPropagation();
    selectMapObjectFromPointer(object.id, event.shiftKey);
    pushMapHistory();
    const startX = event.clientX;
    const startY = event.clientY;
    const originalWidth = object.width;
    const originalHeight = object.height;
    const minimumSizes = {
        room: [180, 120], workplace: [70, 50], wall: [8, 8],
        door: [40, 12], label: [60, 24], zone: [100, 80]
    };
    const [baseMinWidth, baseMinHeight] = minimumSizes[object.type];
    const minWidth = mapSnapEnabled
        ? Math.ceil(baseMinWidth / MAP_GRID_SIZE) * MAP_GRID_SIZE
        : baseMinWidth;
    const minHeight = mapSnapEnabled
        ? Math.ceil(baseMinHeight / MAP_GRID_SIZE) * MAP_GRID_SIZE
        : baseMinHeight;
    const target = event.currentTarget;
    const objectElement = target.parentElement;
    target.setPointerCapture(event.pointerId);

    const move = moveEvent => {
        object.width = clampMapValue(
            snapMapValue(originalWidth + (moveEvent.clientX - startX) / mapZoom),
            minWidth,
            mapWorldWidth - object.x
        );
        object.height = clampMapValue(
            snapMapValue(originalHeight + (moveEvent.clientY - startY) / mapZoom),
            minHeight,
            mapWorldHeight - object.y
        );
        ensureMapWorldSpace(object);
        objectElement.style.width = `${object.width}px`;
        objectElement.style.height = `${object.height}px`;
        markMapDirty();
    };
    const stop = () => {
        target.removeEventListener("pointermove", move);
        renderMapProperties();
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop, {once: true});
    target.addEventListener("pointercancel", stop, {once: true});
}

export function selectMapObjectFromPointer(id, additive = false) {
    if (additive) {
        selectedMapObjectIds.has(id) ? selectedMapObjectIds.delete(id) : selectedMapObjectIds.add(id);
    } else if (!selectedMapObjectIds.has(id)) {
        selectedMapObjectIds = new Set([id]);
    }
    selectedMapObjectId = selectedMapObjectIds.has(id) ? id : ([...selectedMapObjectIds][0] || null);
    document.querySelectorAll(".map-object").forEach(element => {
        element.classList.toggle("selected", selectedMapObjectIds.has(element.dataset.objectId));
    });
    renderMapProperties();
}

export function clampMapValue(value, min, max) {
    return Math.round(Math.max(min, Math.min(max, value)));
}

export function ensureMapWorldSpace(object) {
    let expanded = false;
    if (object.x + object.width > mapWorldWidth - 500 && mapWorldWidth < 50000) {
        mapWorldWidth = Math.min(50000, mapWorldWidth + 2000);
        expanded = true;
    }
    if (object.y + object.height > mapWorldHeight - 500 && mapWorldHeight < 50000) {
        mapWorldHeight = Math.min(50000, mapWorldHeight + 2000);
        expanded = true;
    }
    if (expanded) updateMapSurfaceSize();
}

export function updateMapSmartGuides(object) {
    const threshold = 6 / mapZoom;
    mapSmartGuides = [];
    const candidates = officeMap.objects.filter(item => item.id !== object.id && !selectedMapObjectIds.has(item.id));
    const ownX = [object.x, object.x + object.width / 2, object.x + object.width];
    const ownY = [object.y, object.y + object.height / 2, object.y + object.height];
    for (const other of candidates) {
        const otherX = [other.x, other.x + other.width / 2, other.x + other.width];
        const otherY = [other.y, other.y + other.height / 2, other.y + other.height];
        for (let i = 0; i < ownX.length; i++) {
            for (const targetX of otherX) {
                if (Math.abs(ownX[i] - targetX) <= threshold) {
                    object.x += targetX - ownX[i];
                    mapSmartGuides.push({axis: "x", value: targetX});
                    break;
                }
            }
        }
        for (let i = 0; i < ownY.length; i++) {
            for (const targetY of otherY) {
                if (Math.abs(ownY[i] - targetY) <= threshold) {
                    object.y += targetY - ownY[i];
                    mapSmartGuides.push({axis: "y", value: targetY});
                    break;
                }
            }
        }
        if (mapSmartGuides.length) break;
    }
    const element = document.querySelector(`[data-object-id="${object.id}"]`);
    if (element) { element.style.left = `${object.x}px`; element.style.top = `${object.y}px`; }
    renderMapGuides();
}

export function renderMapGuides() {
    const canvas = document.getElementById("map-canvas");
    if (!canvas) return;
    canvas.querySelectorAll(".map-smart-guide").forEach(item => item.remove());
    mapSmartGuides.forEach(guide => {
        const element = document.createElement("div");
        element.className = `map-smart-guide map-guide-${guide.axis}`;
        if (guide.axis === "x") element.style.left = `${guide.value}px`;
        else element.style.top = `${guide.value}px`;
        canvas.appendChild(element);
    });
}

export function applyMapTemplate(template) {
    if (!template) return;
    const templates = {
        "room-small": ["room", 400, 300], "room-large": ["room", 800, 600],
        workplace: ["workplace", 120, 80], "wall-horizontal": ["wall", 400, 12],
        "wall-vertical": ["wall", 12, 400]
    };
    const [type, width, height] = templates[template];
    const selected = getSelectedMapObjects()[0];
    if (!selected || selected.type !== type) {
        addMapObject(type);
        const created = getSelectedMapObjects()[0];
        if (created) { created.width = width; created.height = height; renderMapObjects(); renderMapProperties(); }
        return;
    }
    pushMapHistory();
    selected.width = width; selected.height = height;
    markMapDirty(); renderMapObjects(); renderMapProperties();
}

export function getMapContentBounds(objects = officeMap.objects) {
    if (!objects.length) return {left: 0, top: 0, right: 1200, bottom: 700};
    return {
        left: Math.min(...objects.map(item => item.x)), top: Math.min(...objects.map(item => item.y)),
        right: Math.max(...objects.map(item => item.x + item.width)),
        bottom: Math.max(...objects.map(item => item.y + item.height))
    };
}

export function focusMapBounds(bounds) {
    const viewport = document.getElementById("map-viewport");
    const stage = document.getElementById("map-canvas-stage");
    if (!viewport || !stage) return;
    const width = Math.max(100, bounds.right - bounds.left);
    const height = Math.max(100, bounds.bottom - bounds.top);
    const zoom = Math.max(0.25, Math.min(1.5, Math.min((viewport.clientWidth - 100) / width, (viewport.clientHeight - 100) / height)));
    setMapZoom(zoom);
    viewport.scrollLeft = stage.offsetLeft + (bounds.left + width / 2) * mapZoom - viewport.clientWidth / 2;
    viewport.scrollTop = stage.offsetTop + (bounds.top + height / 2) * mapZoom - viewport.clientHeight / 2;
    renderMapMinimap();
}

export function fitMapContent() { focusMapBounds(getMapContentBounds()); }
export function focusMapSelection() {
    const objects = getSelectedMapObjects();
    if (objects.length) focusMapBounds(getMapContentBounds(objects));
}

export function renderMapMinimap() {
    const minimap = document.getElementById("map-minimap");
    const viewport = document.getElementById("map-viewport");
    if (!minimap || !viewport) return;
    const bounds = getMapContentBounds();
    const worldWidth = Math.max(1200, bounds.right + 200);
    const worldHeight = Math.max(700, bounds.bottom + 200);
    minimap.innerHTML = officeMap.objects.map(item =>
        `<span class="mini-${item.type}" style="left:${item.x / worldWidth * 100}%;top:${item.y / worldHeight * 100}%;width:${Math.max(1, item.width / worldWidth * 100)}%;height:${Math.max(1, item.height / worldHeight * 100)}%"></span>`
    ).join("") + `<i style="left:${viewport.scrollLeft / mapZoom / worldWidth * 100}%;top:${viewport.scrollTop / mapZoom / worldHeight * 100}%;width:${viewport.clientWidth / mapZoom / worldWidth * 100}%;height:${viewport.clientHeight / mapZoom / worldHeight * 100}%"></i>`;
    minimap.onclick = event => {
        const rect = minimap.getBoundingClientRect();
        viewport.scrollLeft = ((event.clientX - rect.left) / rect.width * worldWidth) * mapZoom - viewport.clientWidth / 2;
        viewport.scrollTop = ((event.clientY - rect.top) / rect.height * worldHeight) * mapZoom - viewport.clientHeight / 2;
        renderMapMinimap();
    };
}

export function renderMapProperties() {
    const panel = document.getElementById("map-properties");
    if (!panel) return;
    const selectedObjects = getSelectedMapObjects();
    if (selectedObjects.length > 1) {
        renderMapMultiProperties(panel, selectedObjects);
        return;
    }
    const object = officeMap.objects.find(item => item.id === selectedMapObjectId);
    if (!object) {
        panel.innerHTML = `
            <h3>Карта</h3>
            <p>Добавьте или выберите объект, чтобы изменить его параметры.</p>
            <p class="map-properties-hint">Объекты можно перетаскивать и растягивать за угол.</p>
        `;
        return;
    }

    const windowOptions = mapWindows.map(item =>
        `<option value="${item.id}" ${item.id === object.window_id ? "selected" : ""}>${escapeMapHtml(item.name)}</option>`
    ).join("");
    const windowSettings = object.type === "workplace" && object.window_id
        ? renderMapWindowSettings(object.window_id)
        : "";
    const objectStatus = getMapObjectStatus(object);
    panel.innerHTML = `
        <h3>${mapObjectTypeName(object.type)}</h3>
        ${objectStatus ? `<div class="map-property-status status-${objectStatus}">${mapStatusName(objectStatus)}</div>` : ""}
        <details class="map-settings-details">
            <summary>Параметры ${mapObjectTypeName(object.type).toLowerCase()}</summary>
            <label class="map-property-field">
                <span>Название</span>
                <input id="map-object-label" maxlength="100" value="${escapeMapHtml(object.label)}">
            </label>
            ${object.type === "workplace" ? `
                <label class="map-property-field">
                    <span>Рабочее место</span>
                    <select id="map-object-window">
                        <option value="">Не привязано</option>
                        ${windowOptions}
                    </select>
                    <button class="map-inline-create" onclick="createMapWindowForSelected()">Создать рабочее место</button>
                </label>
            ` : ""}
            <div class="map-object-size">${object.width} × ${object.height}, позиция ${object.x} × ${object.y}</div>
        </details>
        ${windowSettings}
        <details class="map-settings-details map-danger-details">
            <summary>Копирование и удаление</summary>
            ${object.type === "workplace" ? `<button class="map-duplicate-settings" onclick="duplicateMapWorkplaceWithSettings()">Копировать стол и настройки</button>` : ""}
            <button class="map-delete-button" onclick="deleteSelectedMapObject()">Удалить объект</button>
        </details>
    `;

    document.getElementById("map-object-label").addEventListener("input", event => {
        object.label = event.target.value;
        const title = document.querySelector(`[data-object-id="${object.id}"] .map-object-title`);
        if (title) title.textContent = mapObjectTitle(object);
        markMapDirty();
    });
    document.getElementById("map-object-label").addEventListener("focus", pushMapHistory, {once: true});
    document.getElementById("map-object-window")?.addEventListener("change", event => {
        pushMapHistory();
        object.window_id = event.target.value ? Number(event.target.value) : null;
        renderMapObjects();
        markMapDirty();
        renderMapProperties();
    });

    panel.querySelectorAll(".map-service-check").forEach(checkbox => {
        checkbox.addEventListener("change", event => {
            const priority = panel.querySelector(`[data-priority-for="${event.target.dataset.serviceId}"]`);
            if (priority) priority.disabled = !event.target.checked;
        });
    });

    if (object.window_id && mapWindowServices[object.window_id] === undefined) {
        loadMapWindowServices(object.window_id, object.id);
    }
}

export async function duplicateMapWorkplaceWithSettings() {
    const object = officeMap.objects.find(item => item.id === selectedMapObjectId);
    if (!object || object.type !== "workplace") return;
    pushMapHistory();
    const copy = {...structuredClone(object), id: createMapObjectId(), x: object.x + 30, y: object.y + 30};
    try {
        if (object.window_id) {
            const sourceWindow = mapWindows.find(item => item.id === object.window_id);
            const newWindow = await mapRequest(`${API}/windows/`, {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({name: `${sourceWindow?.name || "Рабочее место"} копия`})
            });
            if (sourceWindow?.status && sourceWindow.status !== "offline") {
                await mapRequest(`${API}/windows/${newWindow.id}/status`, {
                    method: "PATCH", headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({status: sourceWindow.status})
                });
                newWindow.status = sourceWindow.status;
            }
            const links = structuredClone(mapWindowServices[object.window_id] || []);
            await mapRequest(`${API}/window-services/${newWindow.id}`, {
                method: "PUT", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({services: links.map(link => ({service_id: link.service_id, priority: link.priority || 1}))})
            });
            mapWindows.push(newWindow);
            mapWindowServices[newWindow.id] = links.map(link => ({...link, window_id: newWindow.id}));
            copy.window_id = newWindow.id;
        }
        copy.label = `${object.label || "Физический стол"} копия`;
        officeMap.objects.push(copy);
        selectedMapObjectIds = new Set([copy.id]);
        selectedMapObjectId = copy.id;
        markMapDirty(); renderMapObjects(); renderMapProperties();
    } catch (error) {
        mapUndoStack.pop();
        alert(error.message);
    }
}

export function mapObjectTypeName(type) {
    return {room: "Помещение", workplace: "Физический стол", wall: "Стена", door: "Дверь", label: "Подпись", zone: "Зона"}[type] || "Объект";
}

export function mapStatusName(status) {
    return {online: "Онлайн", break: "Перерыв", offline: "Офлайн", unconfigured: "Не настроено", conflict: "Конфликт привязки"}[status] || status;
}

export function renderMapMultiProperties(panel, objects) {
    const workplaces = objects.filter(item => item.type === "workplace" && item.window_id);
    const uniqueWindowCount = new Set(workplaces.map(item => item.window_id)).size;
    const conflicts = objects.filter(item => getMapObjectStatus(item) === "conflict").length;
    panel.innerHTML = `
        <h3>Выбрано: ${objects.length}</h3>
        ${conflicts ? `<div class="map-conflict-message">Конфликтов привязки: ${conflicts}</div>` : ""}
        <details class="map-settings-details">
            <summary>Расположение и копирование</summary>
            <div class="map-multi-actions">
                <button onclick="duplicateMapSelection()">Создать копии</button>
                <button onclick="alignMapSelection('left')">Выровнять слева</button>
                <button onclick="alignMapSelection('top')">Выровнять сверху</button>
                <button onclick="distributeMapSelection('horizontal')">Равные интервалы →</button>
                <button onclick="distributeMapSelection('vertical')">Равные интервалы ↓</button>
            </div>
        </details>
        ${workplaces.length ? `
            <details class="map-window-settings map-settings-details">
                <summary>Массовая смена статуса (${uniqueWindowCount})</summary>
                <select id="map-bulk-window-status">
                    <option value="online">online</option>
                    <option value="break">break</option>
                    <option value="offline">offline</option>
                </select>
                <button onclick="saveBulkMapWindowStatus()">Применить статус</button>
            </details>
            <details class="map-window-settings map-settings-details">
                <summary>Массовое назначение услуг (${workplaces.length})</summary>
                <div class="map-bulk-services">
                    ${mapServices.map(service => `
                        <label><input type="checkbox" value="${service.id}"><span>${escapeMapHtml(service.name)}</span></label>
                    `).join("")}
                </div>
                <button onclick="saveBulkMapServices()">Назначить выбранные услуги</button>
            </details>
        ` : ""}
        <details class="map-settings-details map-danger-details">
            <summary>Удаление</summary>
            <button class="map-delete-button" onclick="deleteSelectedMapObject()">Удалить выбранные объекты</button>
        </details>
    `;
}

export async function saveBulkMapWindowStatus() {
    const status = document.getElementById("map-bulk-window-status")?.value;
    const windowIds = [...new Set(getSelectedMapObjects()
        .filter(item => item.type === "workplace" && item.window_id)
        .map(item => item.window_id))];
    if (!status || !windowIds.length) return;
    try {
        await Promise.all(windowIds.map(windowId => mapRequest(`${API}/windows/${windowId}/status`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({status})
        })));
        mapWindows.forEach(windowItem => {
            if (windowIds.includes(windowItem.id)) windowItem.status = status;
        });
        renderMapObjects();
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function saveBulkMapServices() {
    const panel = document.getElementById("map-properties");
    const serviceIds = [...panel.querySelectorAll(".map-bulk-services input:checked")].map(input => Number(input.value));
    const windowIds = [...new Set(getSelectedMapObjects().filter(item => item.type === "workplace" && item.window_id).map(item => item.window_id))];
    const services = serviceIds.map(serviceId => ({service_id: serviceId, priority: 1}));
    try {
        await Promise.all(windowIds.map(windowId => mapRequest(`${API}/window-services/${windowId}`, {
            method: "PUT", headers: {"Content-Type": "application/json"}, body: JSON.stringify({services})
        })));
        windowIds.forEach(windowId => { mapWindowServices[windowId] = structuredClone(services); });
        renderMapObjects(); renderMapProperties();
    } catch (error) { alert(error.message); }
}

export function renderMapWindowSettings(windowId) {
    const windowItem = mapWindows.find(item => item.id === windowId);
    const assignedOperator = mapOperators.find(operator => operator.window_id === windowId);
    const operatorOptions = mapOperators.map(operator => {
        const otherWindow = operator.window_id && operator.window_id !== windowId
            ? mapWindows.find(item => item.id === operator.window_id)
            : null;
        const disabled = otherWindow ? "disabled" : "";
        const selected = assignedOperator?.id === operator.id ? "selected" : "";
        const suffix = otherWindow ? ` — ${otherWindow.name}` : "";
        return `<option value="${operator.id}" ${selected} ${disabled}>${escapeMapHtml(operator.name + suffix)}</option>`;
    }).join("");

    const linkedServices = mapWindowServices[windowId];
    let servicesHtml = `<div class="map-window-loading">Загрузка услуг...</div>`;
    if (Array.isArray(linkedServices)) {
        const priorities = new Map(linkedServices.map(item => [item.service_id, item.priority ?? 1]));
        servicesHtml = mapServices.length ? mapServices.map(service => {
            const checked = priorities.has(service.id);
            return `
                <div class="map-service-row">
                    <label class="map-service-checkbox" title="Включить услугу">
                        <input class="map-service-check" type="checkbox" data-service-id="${service.id}" ${checked ? "checked" : ""}>
                    </label>
                    <button class="map-service-name" title="Изменить название услуги"
                        onclick="renameMapService(${service.id})">${escapeMapHtml(service.name)}</button>
                    <input class="map-service-priority" type="number" min="1" max="100"
                        data-priority-for="${service.id}" value="${priorities.get(service.id) ?? 1}" ${checked ? "" : "disabled"}>
                </div>
            `;
        }).join("") : `<div class="map-window-loading">Услуг пока нет</div>`;
    }

    return `
        <details class="map-window-settings map-settings-details">
            <summary>Настройка рабочего места</summary>
            <label class="map-settings-field">
                <span>Название рабочего места</span>
                <input id="map-window-name" value="${escapeMapHtml(windowItem?.name || "")}" placeholder="Название">
            </label>
            <label class="map-settings-field">
                <span>Статус</span>
            <select id="map-window-status">
                <option value="online" ${windowItem?.status === "online" ? "selected" : ""}>online</option>
                <option value="break" ${windowItem?.status === "break" ? "selected" : ""}>break</option>
                <option value="offline" ${windowItem?.status === "offline" ? "selected" : ""}>offline</option>
            </select>
            </label>
            <button onclick="saveMapWindow(${windowId})">Сохранить рабочее место</button>
        </details>
        <details class="map-window-settings map-settings-details">
            <summary>Оператор окна</summary>
            <select id="map-window-operator">
                <option value="">Не назначен</option>
                ${operatorOptions}
            </select>
            <button onclick="saveMapWindowOperator(${windowId})">Сохранить оператора</button>
            ${assignedOperator ? `
                <div class="map-entity-editor">
                    <input id="map-operator-name" name="map_operator_name" autocomplete="off"
                        value="${escapeMapHtml(assignedOperator.name)}" placeholder="Имя">
                    <input id="map-operator-login" name="map_operator_login" autocomplete="username"
                        value="${escapeMapHtml(assignedOperator.login || "")}" placeholder="Логин">
                    <input id="map-operator-password" name="map_operator_new_password" type="password"
                        autocomplete="new-password" placeholder="Новый пароль (необязательно)">
                    <button onclick="saveMapOperator(${assignedOperator.id})">Сохранить данные оператора</button>
                </div>
            ` : ""}
            <details class="map-create-details">
                <summary>Создать оператора</summary>
                <input id="map-new-operator-name" name="map_new_operator_name" autocomplete="off" placeholder="Имя">
                <input id="map-new-operator-login" name="map_new_operator_login" autocomplete="off" placeholder="Логин">
                <input id="map-new-operator-password" name="map_new_operator_password" type="password"
                    autocomplete="new-password" placeholder="Пароль">
                <button onclick="createMapOperator(${windowId})">Создать и назначить</button>
            </details>
        </details>
        <details class="map-window-settings map-settings-details">
            <summary>Услуги окна</summary>
            <div class="map-services-list">${servicesHtml}</div>
            ${Array.isArray(linkedServices) ? `<button onclick="saveMapWindowServices(${windowId})">Сохранить услуги</button>` : ""}
            <details class="map-create-details">
                <summary>Создать услугу</summary>
                <input id="map-new-service-name" placeholder="Название услуги">
                <button onclick="createMapService()">Создать услугу</button>
            </details>
        </details>
    `;
}

export async function createMapWindowForSelected() {
    const object = officeMap.objects.find(item => item.id === selectedMapObjectId);
    if (!object || object.type !== "workplace") return;
    const name = prompt("Название рабочего места:", object.label || "Новое рабочее место")?.trim();
    if (!name) return;
    try {
        const windowItem = await mapRequest(`${API}/windows/`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name})
        });
        mapWindows.push(windowItem);
        pushMapHistory();
        object.window_id = windowItem.id;
        markMapDirty();
        renderMapObjects();
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function saveMapWindow(windowId) {
    const name = document.getElementById("map-window-name")?.value.trim();
    const status = document.getElementById("map-window-status")?.value;
    if (!name) return alert("Введите название рабочего места");
    try {
        await mapRequest(`${API}/windows/${windowId}`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name})
        });
        await mapRequest(`${API}/windows/${windowId}/status`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({status})
        });
        const windowItem = mapWindows.find(item => item.id === windowId);
        if (windowItem) Object.assign(windowItem, {name, status});
        renderMapObjects();
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function loadMapWindowServices(windowId, objectId) {
    mapWindowServices[windowId] = null;
    try {
        const data = await mapRequest(`${API}/window-services/${windowId}`);
        mapWindowServices[windowId] = Array.isArray(data) ? data : [];
        if (selectedMapObjectId === objectId) renderMapProperties();
    } catch (error) {
        mapWindowServices[windowId] = [];
        if (selectedMapObjectId === objectId) renderMapProperties();
        alert(error.message);
    }
}

export async function saveMapWindowOperator(windowId) {
    const select = document.getElementById("map-window-operator");
    const operatorId = select?.value ? Number(select.value) : null;
    try {
        await mapRequest(`${API}/windows/${windowId}/operator`, {
            method: "PUT",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({operator_id: operatorId})
        });
        mapOperators.forEach(operator => {
            if (operator.window_id === windowId) operator.window_id = null;
            if (operator.id === operatorId) operator.window_id = windowId;
        });
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function saveMapOperator(operatorId) {
    const operator = mapOperators.find(item => item.id === operatorId);
    const name = document.getElementById("map-operator-name")?.value.trim();
    const login = document.getElementById("map-operator-login")?.value.trim();
    const password = document.getElementById("map-operator-password")?.value;
    if (!name || !login) return alert("Заполните имя и логин оператора");
    if (operator && login !== operator.login && !password) {
        return alert("Для смены логина укажите новый пароль");
    }
    try {
        await mapRequest(`${API}/operators/${operatorId}`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name})
        });
        if (password) {
            await mapRequest(`${API}/operators/${operatorId}/login`, {
                method: "PUT",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({login, password})
            });
        }
        if (operator) Object.assign(operator, {name, login});
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function createMapOperator(windowId) {
    const name = document.getElementById("map-new-operator-name")?.value.trim();
    const login = document.getElementById("map-new-operator-login")?.value.trim();
    const password = document.getElementById("map-new-operator-password")?.value;
    if (!name || !login || !password) return alert("Заполните данные нового оператора");
    try {
        const operator = await mapRequest(`${API}/operators/`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name, login, password, window_id: null})
        });
        await mapRequest(`${API}/windows/${windowId}/operator`, {
            method: "PUT",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({operator_id: operator.id})
        });
        mapOperators.forEach(item => {
            if (item.window_id === windowId) item.window_id = null;
        });
        mapOperators.push({...operator, login, window_id: windowId});
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function saveMapWindowServices(windowId) {
    const panel = document.getElementById("map-properties");
    const linkedServices = [];
    panel.querySelectorAll(".map-service-check:checked").forEach(checkbox => {
        const priority = panel.querySelector(`[data-priority-for="${checkbox.dataset.serviceId}"]`);
        linkedServices.push({
            service_id: Number(checkbox.dataset.serviceId),
            priority: Math.max(1, Math.min(100, Number(priority?.value) || 1))
        });
    });
    try {
        await mapRequest(`${API}/window-services/${windowId}`, {
            method: "PUT",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({services: linkedServices})
        });
        mapWindowServices[windowId] = linkedServices;
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function createMapService() {
    const input = document.getElementById("map-new-service-name");
    const name = input?.value.trim();
    if (!name) return alert("Введите название услуги");
    try {
        const service = await mapRequest(`${API}/services`, {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name, operator_choice_enabled: false})
        });
        mapServices.push(service);
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export async function renameMapService(serviceId) {
    const service = mapServices.find(item => item.id === serviceId);
    if (!service) return;
    const name = prompt("Название услуги:", service.name)?.trim();
    if (!name || name === service.name) return;
    try {
        await mapRequest(`${API}/services/${serviceId}`, {
            method: "PATCH",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({name})
        });
        service.name = name;
        renderMapProperties();
    } catch (error) {
        alert(error.message);
    }
}

export function deleteSelectedMapObject() {
    if (!selectedMapObjectIds.size) return;
    const objects = getSelectedMapObjects();
    if ((objects.length > 1 || objects.some(item => item.window_id)) &&
        !confirm(`Удалить с карты объектов: ${objects.length}? Связанные записи в БД останутся.`)) return;
    pushMapHistory();
    officeMap.objects = officeMap.objects.filter(item => !selectedMapObjectIds.has(item.id));
    selectedMapObjectId = null;
    selectedMapObjectIds = new Set();
    markMapDirty();
    renderMapObjects();
    renderMapProperties();
    renderMapMinimap();
}

export function markMapDirty() {
    mapDirty = true;
    updateMapSaveState();
}

export function updateMapSaveState(text) {
    const state = document.getElementById("map-save-state");
    if (!state) return;
    state.textContent = text || (mapDirty ? "Есть несохранённые изменения" : "Все изменения сохранены");
    state.classList.toggle("dirty", mapDirty);
}

export async function saveOfficeMap() {
    updateMapSaveState("Сохранение...");
    try {
        officeMap.width = mapWorldWidth;
        officeMap.height = mapWorldHeight;
        officeMap = await mapRequest(`${API}/admin/map`, {
            method: "PUT",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(officeMap)
        });
        mapDirty = false;
        updateMapSaveState();
    } catch (error) {
        updateMapSaveState("Не удалось сохранить");
        alert(error.message);
    }
}

export function escapeMapHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
