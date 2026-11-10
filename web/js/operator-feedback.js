(function initializeOperatorFeedback(global) {
    let toastTimer = null;

    function toast(message, type = "danger") {
        const element = document.getElementById("toast-notification");
        if (!element) return;

        const variants = {
            danger: {symbol: "!"},
            warning: {symbol: "!"},
            success: {symbol: "✓"}
        };
        const variant = variants[type] || variants.danger;
        const icon = document.createElement("span");
        icon.className = "operator-toast-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = variant.symbol;
        const content = document.createElement("div");
        content.className = "operator-toast-content";
        const description = document.createElement("p");
        description.textContent = message === "Нет ожидающих билетов"
            ? "Нет ожидающих талонов" : message;
        content.append(description);
        const close = document.createElement("button");
        close.type = "button";
        close.className = "operator-toast-close";
        close.setAttribute("aria-label", "Закрыть уведомление");
        close.textContent = "×";
        close.addEventListener("click", () => {
            clearTimeout(toastTimer);
            element.style.display = "none";
        });
        element.replaceChildren(icon, content, close);
        element.dataset.type = type;
        element.setAttribute("role", type === "danger" ? "alert" : "status");
        element.setAttribute("aria-live", type === "danger" ? "assertive" : "polite");
        element.style.display = "flex";
        if (toastTimer) clearTimeout(toastTimer);
        if (type === "danger") return;
        toastTimer = setTimeout(() => {
            element.style.display = "none";
        }, 4000);
    }

    function dialog({title, message, actions, content}) {
        const existing = document.querySelector(".operator-popup-overlay");
        if (existing) existing.remove();

        const overlay = document.createElement("div");
        overlay.className = "operator-popup-overlay";

        const popup = document.createElement("div");
        popup.className = "operator-popup";
        popup.setAttribute("role", "dialog");
        popup.setAttribute("aria-modal", "true");

        const titleElement = document.createElement("h2");
        titleElement.textContent = title;
        popup.appendChild(titleElement);

        if (message) {
            const messageElement = document.createElement("p");
            messageElement.textContent = message;
            popup.appendChild(messageElement);
        }
        if (content) popup.appendChild(content);

        const actionsElement = document.createElement("div");
        actionsElement.className = "operator-popup-actions";
        actions.forEach(action => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = action.className || "btn-outline";
            button.textContent = action.text;
            button.addEventListener("click", () => {
                if (action.close !== false) overlay.remove();
                if (typeof action.onClick === "function") action.onClick();
            });
            actionsElement.appendChild(button);
        });

        popup.appendChild(actionsElement);
        overlay.appendChild(popup);
        document.body.appendChild(overlay);
        return {overlay, popup};
    }

    function confirm({title, message, confirmText = "Продолжить", danger = false}) {
        return new Promise(resolve => {
            let settled = false;
            const settle = value => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            const {overlay} = dialog({
                title,
                message,
                actions: [
                    {text: "Отмена", onClick: () => settle(false)},
                    {
                        text: confirmText,
                        className: danger ? "btn-danger" : "btn-primary",
                        onClick: () => settle(true)
                    }
                ]
            });
            overlay.addEventListener("click", event => {
                if (event.target === overlay) {
                    overlay.remove();
                    settle(false);
                }
            });
        });
    }

    function acknowledge({title, message, buttonText = "Понятно"}) {
        return new Promise(resolve => {
            dialog({
                title,
                message,
                actions: [{text: buttonText, className: "btn-primary", onClick: resolve}]
            });
        });
    }

    function input({
        title,
        message,
        label,
        placeholder = "",
        value = "",
        inputMode = "text",
        submitText = "Продолжить",
        validate
    }) {
        return new Promise(resolve => {
            const content = document.createElement("div");
            content.className = "operator-popup-form";

            const labelElement = document.createElement("label");
            labelElement.textContent = label;
            const inputElement = document.createElement("input");
            inputElement.className = "operator-popup-input";
            inputElement.placeholder = placeholder;
            inputElement.value = value;
            inputElement.inputMode = inputMode;
            labelElement.appendChild(inputElement);

            const errorElement = document.createElement("small");
            errorElement.className = "operator-popup-error";
            content.appendChild(labelElement);
            content.appendChild(errorElement);

            let settled = false;
            const settle = result => {
                if (settled) return;
                settled = true;
                resolve(result);
            };
            const submit = () => {
                const inputValue = inputElement.value.trim();
                const error = typeof validate === "function" ? validate(inputValue) : "";
                if (error) {
                    errorElement.textContent = error;
                    inputElement.focus();
                    return;
                }
                overlay.remove();
                settle(inputValue);
            };
            const {overlay} = dialog({
                title,
                message,
                content,
                actions: [
                    {text: "Отмена", onClick: () => settle(null)},
                    {text: submitText, className: "btn-primary", close: false, onClick: submit}
                ]
            });
            inputElement.addEventListener("keydown", event => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    submit();
                }
            });
            setTimeout(() => inputElement.focus(), 0);
        });
    }

    global.OperatorFeedback = {toast, dialog, confirm, acknowledge, input};
})(window);
