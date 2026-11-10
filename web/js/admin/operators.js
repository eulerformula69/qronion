import { fetchJSON } from "./api.js";
import { setActiveTab, setForm, setTable } from "./dom.js";

const API = CONFIG.API_URL;
let windows = [];
let operators = [];
let services = [];
let operatorSettings = {};
let openedServices = null;

function resetOpened() {
    openedServices?.remove();
    openedServices = null;
}

function getWindowName(id) {
    const windowItem = windows.find(item => item.id === id);
    return windowItem ? windowItem.name : "-";
}

function getAutoCallModeLabel(mode) {
    if (mode === "enabled") return "Включён";
    if (mode === "disabled") return "Выключен";
    return "По общей настройке";
}

export async function loadOperators(){
	resetOpened();
	// Показываем форму и таблицу обратно
    document.getElementById("form").style.display = "block";
    document.getElementById("table").style.display = "table";
    // Удаляем блок статистики, чтобы он не мешал
    const statsContainer = document.getElementById("stats-container");
    if (statsContainer) statsContainer.remove();	
	setActiveTab('tab-operators');
    // fetchJSON сам подставит session-id и выкинет на логин при ошибке 401
    windows = await fetchJSON(`${API}/windows/`);
    operators = await fetchJSON(`${API}/operators/`);
    services = await fetchJSON(`${API}/services/`);
    operatorSettings = await fetchJSON(`${API}/admin/settings`) || {};
    operators.sort((a,b) => a.id - b.id);

    let html = `<tr><th>ID</th><th>Имя</th><th>Рабочее место</th><th>Автовызов</th><th>Действия</th></tr>`;

    for(let op of operators){
        html += `
        <tr id="row-${op.id}">
          <td>${op.id}</td>
          <td id="name-${op.id}">${op.name}</td>
          <td id="window-${op.id}">${getWindowName(op.window_id)}</td>
          <td id="auto-call-${op.id}">${getAutoCallModeLabel(op.auto_call_mode)}</td>
          <td>
            <button onclick="editOperatorName(${op.id},'${op.name}')">Имя</button>
            <button onclick="editOperatorWindow(${op.id},${op.window_id})">Рабочее место</button>
            <button onclick="editOperatorAutoCall(${op.id},'${op.auto_call_mode || "default"}')">Автовызов</button>
            <button onclick="editLoginPassword(${op.id})">Данные</button>
            <button style="background: #ffcccc;" onclick="deleteOperator(${op.id})">Удалить</button>
          </td>
        </tr>`;
    }

    setTable(html);
    setForm(`
        <div class="form">
          <h3>Автовызов</h3>
          <label>
            <input type="checkbox" id="operator-auto-call-enabled" ${operatorSettings.auto_call_enabled ? "checked" : ""}>
            Автовызов по умолчанию для операторов
          </label>
          <input
            id="operator-auto-call-delay-seconds"
            type="number"
            min="0"
            max="600"
            step="1"
            value="${operatorSettings.auto_call_delay_seconds ?? 60}"
            placeholder="До системного вызова, сек."
          >
          <button onclick="saveOperatorAutoCallSettings()">Сохранить автовызов</button>
          <hr>
          <input id="newOperatorName" placeholder="Имя оператора">
          <input id="newOperatorLogin" placeholder="Логин">
          <input id="newOperatorPassword" placeholder="Пароль">
          <button onclick="addOperator()">Добавить</button>
        </div>
    `);
}

//////// имя оператора
export function editOperatorName(id,name){
  // если уже открыто для этого оператора — закрываем
  if(openedServices && openedServices.dataset.type === "name" && openedServices.dataset.operatorId == id){
    openedServices.remove();
    openedServices = null;
    return;
  }
  // закрываем любое другое открытое окно
  openedServices?.remove();
  openedServices = null;

  let row = document.getElementById("row-"+id);

  let html = '<tr class="nameRow" data-operator-id="'+id+'" data-type="name">' +
             '<td></td><td></td><td></td><td></td>' +
             '<td><input id="nameInput-'+id+'" value="'+name+'"> ' +
             '<button onclick="saveOperatorName('+id+')">OK</button></td></tr>';

  row.insertAdjacentHTML("afterend", html);
  openedServices = row.nextElementSibling;
}

export async function saveOperatorName(id){

let name=document.getElementById(`nameInput-${id}`).value

const res = await fetchJSON(`${API}/operators/${id}`,{
method:"PATCH",
headers:{"Content-Type":"application/json"},
body:JSON.stringify({name})
});

if (!res) return;

loadOperators();
resetOpened();
}

//////// окно оператора
export function editOperatorWindow(id,current){
  if(openedServices && openedServices.dataset.type === "window" && openedServices.dataset.operatorId == id){
    openedServices.remove();
    openedServices = null;
    return;
  }
  openedServices?.remove();

  let html = '<tr class="windowRow" data-operator-id="'+id+'" data-type="window">' +
             '<td></td><td></td><td></td><td></td>' +
             '<td><select id="windowSelect-'+id+'">';
  html += '<option value="">Нет окна</option>';
  for(let w of windows){
    html += '<option value="'+w.id+'" '+(w.id===current?"selected":"")+'>'+w.name+'</option>';
  }
  html += '</select> <button onclick="saveOperatorWindow('+id+')">OK</button></td></tr>';

  let row = document.getElementById("row-"+id);
  row.insertAdjacentHTML("afterend",html);

  openedServices = row.nextElementSibling;
}

export async function saveOperatorWindow(id){

let val=document.getElementById(`windowSelect-${id}`).value
let window_id=val===""?null:parseInt(val)

const r = await fetch(`${API}/operators/${id}`,{
method:"PATCH",
headers:{
    "Content-Type":"application/json",
    "session-id": sessionStorage.getItem("session_id")
},
body:JSON.stringify({window_id})
});

if(!r.ok){
  if (r.status === 401 || r.status === 403) {
    alert("Сессия истекла или недостаточно прав. Войдите снова.");
    window.location.href = "login.html";
    return;
  }
  let err = {};
  try { err = await r.json(); } catch (_) {}
  alert(err.detail || "Не удалось сохранить рабочее место оператора");
  return;
}
loadOperators();
resetOpened();
}

export async function saveOperatorAutoCallSettings(){
  const auto_call_delay_seconds = Number(document.getElementById("operator-auto-call-delay-seconds").value);
  if (!Number.isInteger(auto_call_delay_seconds) || auto_call_delay_seconds < 0 || auto_call_delay_seconds > 600) {
    alert("Задержка автовызова должна быть целым числом от 0 до 600 секунд");
    return;
  }

  const res = await fetchJSON(`${API}/admin/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...operatorSettings,
      auto_call_enabled: document.getElementById("operator-auto-call-enabled").checked,
      auto_call_delay_seconds
    })
  });

  if (res) {
    operatorSettings = res;
    alert("Настройки автовызова сохранены");
    loadOperators();
  }
}

export function editOperatorAutoCall(id, current){
  if(openedServices && openedServices.dataset.type === "auto-call" && openedServices.dataset.operatorId == id){
    openedServices.remove();
    openedServices = null;
    return;
  }
  openedServices?.remove();

  const mode = current || "default";
  const html = '<tr class="autoCallRow" data-operator-id="'+id+'" data-type="auto-call">' +
             '<td></td><td></td><td></td><td></td>' +
             '<td><select id="autoCallSelect-'+id+'">' +
             '<option value="default" '+(mode==="default"?"selected":"")+'>По общей настройке</option>' +
             '<option value="enabled" '+(mode==="enabled"?"selected":"")+'>Включён</option>' +
             '<option value="disabled" '+(mode==="disabled"?"selected":"")+'>Выключен</option>' +
             '</select> <button onclick="saveOperatorAutoCall('+id+')">OK</button></td></tr>';

  const row = document.getElementById("row-"+id);
  row.insertAdjacentHTML("afterend", html);
  openedServices = row.nextElementSibling;
}

export async function saveOperatorAutoCall(id){
  const auto_call_mode = document.getElementById(`autoCallSelect-${id}`).value || "default";
  const res = await fetchJSON(`${API}/operators/${id}`,{
    method:"PATCH",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({auto_call_mode})
  });

  if (!res) return;

  loadOperators();
  resetOpened();
}


//////// ДОБАВЛЕНИЕ ОПЕРАТОРА
export async function addOperator() {
  const loginInput = document.getElementById("newOperatorLogin");
  const passwordInput = document.getElementById("newOperatorPassword");
  const nameInput = document.getElementById("newOperatorName");

  const login = loginInput.value.trim();
  const password = passwordInput.value.trim();
  const name = nameInput.value.trim();

  if (!login || !password || !name) return alert("Заполните все поля");
  // Используем fetchJSON: он сам добавит header "session-id"
  // и вернет тело ответа (JSON), если статус 200-299.
  // Если случится ошибка (например 400 или 401), fetchJSON сам покажет alert или редиректнет.
  const res = await fetchJSON(`${API}/operators/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login, password, name, window_id: null })
  });
  // Если res определен, значит запрос прошел успешно
  if (res) {
    // Очистка полей
    loginInput.value = "";
    passwordInput.value = "";
    nameInput.value = "";

    alert("Оператор успешно добавлен");
    loadOperators();
  }
}

//////// ОЧЕРЕДЬ
export async function loadTickets(){

let tickets=await fetchJSON(`${API}/tickets/`)
let services=await fetchJSON(`${API}/services/`)

let html=`<tr>
<th>Номер</th>
<th>Услуга</th>
<th>Статус</th>
</tr>`

for(let t of tickets){

let service = services.find(s => s.id === t.service_id)

html+=`
<tr>
<td>${t.number}</td>
<td>${service ? service.name : "Unknown"}</td>
<td>${t.status}</td>
</tr>`
}

setTable(html)
setForm("")
}

export async function editLoginPassword(operator_id) {
    // Если окно уже открыто для этого оператора — закрываем его
    if (openedServices && openedServices.dataset.operatorId == operator_id) {
        openedServices.remove();
        openedServices = null;
        return;
    }
    // Закрываем любое другое открытое окно
    openedServices?.remove();
    openedServices = null;
    // Получаем данные оператора
    let op = operators.find(o => o.id === operator_id);
    let currentLogin = op.login || "";
    let currentPassword = op.password || ""; // чтобы пароль был виден

let html = `
<tr id="loginPassRow" data-operator-id="${operator_id}">
<td></td>
<td></td>
<td></td>
<td></td>
<td>
<div class="servicesBox">
<b>Сменить логин и пароль</b><br><br>
<label><input id="loginInput-${operator_id}" value="${currentLogin}"></label><br>
<label><input id="passwordInput-${operator_id}" value="${currentPassword}"></label><br><br>
<button onclick="saveLoginPassword(${operator_id})">Сохранить</button>
</div>
</td>
</tr>
`;

    let row = document.getElementById(`row-${operator_id}`);
    row.insertAdjacentHTML("afterend", html);

    openedServices = document.getElementById("loginPassRow");
}

export async function saveLoginPassword(operator_id) {
    let login = document.getElementById(`loginInput-${operator_id}`).value.trim();
    let password = document.getElementById(`passwordInput-${operator_id}`).value.trim();

    if(!login || !password) return alert("Заполните оба поля");
    // Извлекаем токен администратора из хранилища
    const sessionId = sessionStorage.getItem("session_id");

    if (!sessionId) {
        alert("Ошибка: у вас нет прав для выполнения этого действия");
        return;
    }

    let res = await fetch(`${API}/operators/${operator_id}/login`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            // Передаем токен бэкенду
            "session-id": sessionId
        },
        body: JSON.stringify({login, password})
    });

    if(!res.ok){
        // Проверяем, не вызвана ли ошибка отсутствием прав (401 или 403)
        if (res.status === 401 || res.status === 403) {
            return alert("Ошибка доступа: только администратор может менять пароли");
        }
        let err = await res.text();
        return alert("Ошибка при обновлении: " + err);
    }

    alert("Данные входа обновлены");
    // Очистка интерфейса (из вашего исходного кода)
    if (typeof openedServices !== 'undefined' && openedServices) {
        openedServices.remove();
        openedServices = null;
    }
	resetOpened();
    loadOperators();
}

export async function deleteOperator(id) {
    if (!confirm("Вы уверены?")) return;

    try {
        // Заменяем fetch на fetchJSON
        const res = await fetchJSON(`${API}/operators/${id}`, {
            method: "DELETE"
        });
        // Если запрос прошел (res не undefined), обновляем список
        if (res) {
            alert("Оператор удален");
            loadOperators();
        }
    } catch (e) {
        console.error("Ошибка удаления:", e);
        alert("Не удалось удалить оператора");
    }
}

// основной обработчик закрытия страницы
