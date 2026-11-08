# Operator changelog policy

- `queue/changelog/operator.json` обновляется только при изменениях, которые видит оператор или которые меняют операторский workflow.
- Не обновлять operator changelog для изменений табло, терминала, админки, статистики и backend-only refactoring.
- При обновлении changelog нужно увеличить `version` и добавить короткие русские пункты изменений.
- Писать только то, что важно оператору.
