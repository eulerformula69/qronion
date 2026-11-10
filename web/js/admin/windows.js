import { fetchJSON } from "./api.js";
import { setActiveTab, setForm, setTable } from "./dom.js";

const API = CONFIG.API_URL;
let windows = [];
let services = [];
let openedServices = null;

function resetOpened() {
    openedServices?.remove();
    openedServices = null;
}

//////// ОКНА
export async function loadWindows() {
	resetOpened();
	// Показываем форму и таблицу обратно
    document.getElementById("form").style.display = "block";
    document.getElementById("table").style.display = "table"; 
    // Удаляем блок статистики, чтобы он не мешал
    const statsContainer = document.getElementById("stats-container");
    if (statsContainer) statsContainer.remove();	
	
	setActiveTab('tab-windows');
    windows = await fetchJSON(`${API}/windows/`);

    let html = `<tr>
        <th>ID</th>
        <th>Название</th>
        <th>Статус</th>
        <th>Действия</th>
    </tr>`;

    for (let w of windows) {
        html += `
        <tr id="window-${w.id}">
            <td>${w.id}</td>
            <td id="windowName-${w.id}">${w.name}</td>
            <td id="windowStatus-${w.id}">${w.status}</td>
            <td>
                <button onclick="editWindow(${w.id},'${w.name}')">Название</button>
                <button onclick="editWindowStatus(${w.id}, '${w.status}')">Статус</button>
				<button onclick="editServices(${w.id})">Услуги</button>
                <button style="background: #ffcccc;" onclick="deleteWindow(${w.id})">Удалить</button>
            </td>
        </tr>`;
    }
    setTable(html);
    setForm(`
    <div class="form">
        <input id="newWindowName" placeholder="Название окна">
        <button onclick="addWindow()">Добавить рабочее место</button>
    </div>
    `);
}

export function editWindowStatus(id, currentStatus) {
  // если уже открыто для этого окна — закрываем
  if (openedServices && openedServices.dataset.type === "status" && openedServices.dataset.windowId == id) {
    openedServices.remove();
    openedServices = null;
    return;
  }
  // закрываем любое другое открытое окно/строку статуса
  openedServices?.remove();
  openedServices = null;

  let row = document.getElementById(`window-${id}`);
  let html = `
  <tr class="windowStatusRow" data-window-id="${id}" data-type="status">
    <td></td>
    <td></td>
    <td></td>
    <td>
      <select id="windowStatusSelect-${id}">
        <option value="online" ${currentStatus==="online"?"selected":""}>online</option>
        <option value="break" ${currentStatus==="break"?"selected":""}>break</option>
        <option value="offline" ${currentStatus==="offline"?"selected":""}>offline</option>
      </select>
	  <button onclick="saveWindowStatus(${id})">Сохранить</button>
    </td>
  </tr>
  `;
  row.insertAdjacentHTML("afterend", html);
  openedServices = row.nextElementSibling;
}

export async function saveWindowStatus(id) {
  let status = document.getElementById(`windowStatusSelect-${id}`).value;
  // Заменяем fetch на fetchJSON, который автоматически подставит session-id
  let res = await fetchJSON(`${API}/windows/${id}/status`, {
    method: "PATCH",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({status})
  });
  
  if(!res) return; // fetchJSON сам покажет ошибку, если сессия истекла
  
  openedServices.remove();
  resetOpened();
  loadWindows();
}

// Редактирование названия окна на строку ниже
export function editWindow(id, name) {
	  // если уже открыто для этого окна — закрываем
	  if(openedServices && openedServices.dataset.type === "window" && openedServices.dataset.windowId == id){
		openedServices.remove();
		openedServices = null;
		return;
	  }
	  // закрываем любое другое открытое окно
	  openedServices?.remove();
	  openedServices = null;
	  
    let row = document.getElementById(`window-${id}`);
	let html = `
	<tr class="windowEditRow" data-window-id="${id}" data-type="window">
	  <td></td>
	  <td></td>
	  <td></td>
	  <td>
		<input id="windowInput-${id}" value="${name}" style="width:10%; box-sizing:border-box;">
		<button onclick="saveWindow(${id})">Сохранить</button>
	  </td>
	</tr>
	`;
    row.insertAdjacentHTML("afterend", html);
    openedServices = row.nextElementSibling;
}

export async function saveWindow(id) {
    const inputElement = document.getElementById(`windowInput-${id}`);
    if (!inputElement) return;
    const name = inputElement.value.trim();
    if (!name) return alert("Введите название окна");
    // Используем fetchJSON вместо обычного fetch для автоматической авторизации
    const res = await fetchJSON(`${API}/windows/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    // Если res не определен (undefined), значит fetchJSON перенаправил на логин или выдал ошибку
    if (res) {
        // Опционально: можно добавить уведомление об успехе
        console.log(`Рабочее место ${id} успешно обновлено`);
        resetOpened();
		loadWindows();
		
    }
}
// Добавление окна
export async function addWindow() {
    const input = document.getElementById("newWindowName");
    const name = input.value.trim();
    
    if (!name) return alert("Введите название нового окна");
    // Используем fetchJSON для автоматической передачи session-id
    const res = await fetchJSON(`${API}/windows/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });
    // Если запрос успешен (res не undefined)
    if (res) {
        input.value = ""; // Очищаем поле ввода
        alert("Рабочее место успешно добавлено");
        loadWindows();    // Обновляем список окон
    }
}

// Удаление окна с проверкой на наличие услуг
export async function deleteWindow(id) {
    try {
        // 1. Загружаем список услуг, привязанных к этому окну
        // Мы делаем запрос к эндпоинту, который возвращает услуги конкретного окна
        const linkedServices = await fetchJSON(`${API}/window-services/${id}`);
        // 2. Если массив не пустой, значит услуги есть — прерываем удаление
        if (Array.isArray(linkedServices) && linkedServices.length > 0) {
            alert("Нельзя удалить рабочее место: сначала удалите все услуги, привязанные к этому рабочему месту в меню 'Услуги'!");
            return;
        }
        // 3. Если услуг нет, запрашиваем подтверждение
        if (!confirm("Вы уверены, что хотите удалить это рабочее место?")) return;
        // 4. Отправляем запрос на удаление
        const res = await fetchJSON(`${API}/windows/${id}`, {
            method: "DELETE"
        });
        if (res) {
            alert("Рабочее успешно удалено");
            loadWindows(); // Обновляем таблицу
        }
    } catch (e) {
        console.error("Ошибка при проверке или удалении окна:", e);
        alert("Произошла ошибка. Проверьте соединение с сервером.");
    }
}

export function getWindowName(id){

let w=windows.find(x=>x.id===id)
return w?w.name:"-"
}

//////// услуги окна
export async function editServices(window_id) {
    if (openedServices && openedServices.dataset.windowId == window_id) {
        openedServices.remove();
        openedServices = null;
        return;
    }

    openedServices?.remove();
    openedServices = null;

    let ws = await fetchJSON(`${API}/window-services/${window_id}`);

    let selectedMap = {};
    if (Array.isArray(ws)) {
        ws.forEach(item => {
            selectedMap[item.service_id] = item.priority ?? 1;
        });
    }

    let html = `<tr id="servicesRow" data-window-id="${window_id}">
        <td colspan="4">
            <div class="servicesBoxServices" style="max-width:600px; background:#fff; padding:15px; border:1px solid #ccc; border-radius:8px; margin:10px auto;">
                <b>Настройка услуг (меньше число - выше приоритет)</b><br><br>`;

	if (!services.length) {
    services = await fetchJSON(`${API}/services/?include_hidden=true`);
}

    for (let s of services) {
        let isActive = selectedMap.hasOwnProperty(s.id);
        let checked = isActive ? "checked" : "";
        let prio = isActive ? selectedMap[s.id] : 1;
        let disabled = isActive ? "" : "disabled";

        html += `
            <div style="margin-bottom:8px; display:flex; align-items:center;">
                <label style="flex:1">
                    <input type="checkbox" class="srv-check" value="${s.id}" ${checked} 
                           onchange="document.getElementById('prio-${s.id}').disabled = !this.checked"> 
                    ${s.name}
                </label>
                <input type="number" id="prio-${s.id}" class="srv-prio" 
                       value="${prio}" min="1" max="100" 
                       style="width:60px" ${disabled}>
            </div>`;
    }

    html += `<br><button onclick="saveServicesWithPriority(${window_id})">Сохранить</button>
            </div>
        </td>
    </tr>`;

    let row = document.getElementById(`window-${window_id}`);
    row.insertAdjacentHTML("afterend", html);
    openedServices = document.getElementById("servicesRow");
}

export async function saveServicesWithPriority(windowId) {
    const services = [];

    document.querySelectorAll('.srv-check').forEach(cb => {
        if (cb.checked) {
            const serviceId = parseInt(cb.value);
            const prioInput = document.getElementById(`prio-${serviceId}`);

            services.push({
                service_id: serviceId,
                priority: parseInt(prioInput.value) || 1
            });
        }
    });

    const payload = { services };

    const res = await fetchJSON(`${API}/window-services/${windowId}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    if (res) {
        alert("Настройки сохранены");
        loadWindows();
		resetOpened();
    }
}

export async function saveServices(window_id) {
    const container = document.getElementById("servicesRow");
    // Находим все чекбоксы услуг
    const checkboxes = container.querySelectorAll(".srv-checkbox");
    
    let servicesToSave = [];
    
    checkboxes.forEach(cb => {
        if (cb.checked) {
            const srvId = parseInt(cb.value);
            // Находим соответствующий инпут приоритета по ID
            const prioInput = document.getElementById(`prio-input-${srvId}`);
            
            servicesToSave.push({
                service_id: srvId,
                priority: parseInt(prioInput.value) || 1
            });
        }
    });

    try {
        // Важно: отправляем объект с ключом "services", как ожидает Pydantic на бэке
		const res = await fetchJSON(`${API}/window-services/${windowId}`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify(payload)
		});

        alert("Изменения успешно сохранены");
        // Закрываем строку настроек
        openedServices.remove();
        openedServices = null;
    } catch (e) {
        console.error("Save error:", e);
        alert("Ошибка при сохранении приоритетов");
    }
	resetOpened();
}
