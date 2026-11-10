let ctx;
let schedule;

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const OPERATOR_ACTIONS = [
    {value: "offline", title: "Выход", description: "Офлайн и завершить сессии"},
    {value: "offline_keep_session", title: "Офлайн", description: "Сессии останутся открыты"},
    {value: "break", title: "Перерыв", description: "Можно быстро вернуться к работе"}
];
const TICKET_ACTIONS = [
    {value: "cancel", title: "Отменить открытые", description: "Ожидающие и обслуживаемые талоны будут отменены"},
    {value: "finish", title: "Завершить обслуживаемые", description: "Остальные открытые талоны будут отменены"}
];

export async function mount(context) {
    ctx = context;
    schedule = await ctx.api.request("/admin/close-day-schedule");
    render();
}

function render() {
    const selectedDays = new Set(schedule.weekdays || []);
    ctx.view.innerHTML = `
        <form id="close-day-schedule-form" class="admin-scheduler-form">
            <section class="admin-card admin-form admin-scheduler-card ${schedule.enabled ? "is-enabled" : ""}">
                <div class="admin-scheduler-heading">
                    <div>
                        <span class="admin-scheduler-eyebrow">Закрытие смены</span>
                        <h2>${schedule.enabled ? "Расписание активно" : "Расписание выключено"}</h2>
                        <p>Выполняется на сервере по времени Иркутска. Админку можно закрыть.</p>
                    </div>
                    <label class="admin-scheduler-enabled">
                        <span>Включено</span>
                        ${ctx.ui.switchField("enabled", schedule.enabled)}
                    </label>
                </div>

                <fieldset class="admin-scheduler-days">
                    <legend>Дни недели</legend>
                    <div>${DAYS.map((day, index) => `
                        <label class="admin-day-toggle">
                            <input type="checkbox" name="weekday" value="${index}" ${selectedDays.has(index) ? "checked" : ""}>
                            <span>${day}</span>
                        </label>`).join("")}</div>
                </fieldset>

                <div class="admin-scheduler-grid">
                    <label class="admin-field admin-scheduler-time-field">
                        <span>Время закрытия</span>
                        <span class="admin-time-input-wrap">
                            <input class="admin-input" name="run_time" value="${ctx.ui.escapeHtml(schedule.run_time)}"
                                inputmode="numeric" maxlength="5" placeholder="18:00"
                                pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" aria-describedby="scheduler-time-hint" required>
                            <strong>ИРКТ</strong>
                        </span>
                        <small id="scheduler-time-hint">24-часовой формат · ЧЧ:ММ</small>
                    </label>
                </div>
                ${renderChoiceGroup("Что сделать с операторами", "operator_action", OPERATOR_ACTIONS, schedule.operator_action)}
                ${renderChoiceGroup("Что сделать с талонами", "ticket_action", TICKET_ACTIONS, schedule.ticket_action)}
                <div class="admin-scheduler-actions">
                    ${ctx.ui.button("Сохранить расписание", {variant: "primary", action: "save-schedule", type: "submit"})}
                </div>
            </section>
        </form>`;
    ctx.view.querySelector("form").addEventListener("submit", save);
    const timeInput = ctx.view.querySelector('[name="run_time"]');
    timeInput.addEventListener("input", formatTime);
    timeInput.addEventListener("blur", normalizeTime);
}

function renderChoiceGroup(title, name, options, selected) {
    return `<fieldset class="admin-scheduler-choice-group admin-scheduler-choice-group-${name}">
        <legend>${ctx.ui.escapeHtml(title)}</legend>
        <div class="admin-scheduler-choices">${options.map(option => `
            <label class="admin-scheduler-choice">
                <input type="radio" name="${name}" value="${option.value}" ${option.value === selected ? "checked" : ""}>
                <span><strong>${ctx.ui.escapeHtml(option.title)}</strong><small>${ctx.ui.escapeHtml(option.description)}</small></span>
            </label>`).join("")}</div>
    </fieldset>`;
}

function formatTime(event) {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
    event.target.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

function normalizeTime(event) {
    const digits = event.target.value.replace(/\D/g, "");
    if (digits.length === 3) event.target.value = `0${digits[0]}:${digits.slice(1)}`;
}

async function save(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const weekdays = [...form.querySelectorAll('[name="weekday"]:checked')].map(input => Number(input.value));
    if (!weekdays.length) {
        ctx.toast("Выберите хотя бы один день недели", "error");
        return;
    }
    const submit = form.querySelector('[data-action="save-schedule"]');
    submit.disabled = true;
    try {
        schedule = await ctx.api.json("/admin/close-day-schedule", {
            method: "PUT",
            body: {
                enabled: form.elements.enabled.checked,
                weekdays,
                run_time: form.elements.run_time.value,
                operator_action: form.elements.operator_action.value,
                ticket_action: form.elements.ticket_action.value
            }
        });
        ctx.toast("Расписание сохранено", "success");
        render();
    } finally {
        submit.disabled = false;
    }
}
