## ADDED Requirements

### Requirement: Окружение шага называет попытку работы

Окружение каждого шага и его проверок `expect` SHALL содержать `STEPCAST_JOB_ATTEMPT` — номер текущей попытки работы, начиная с 1, — и `STEPCAST_JOB_ATTEMPT_MAX` — действующее значение `attempts.max` работы.
У работы без `attempts` переменные MUST присутствовать со значениями `1` и
`1`. Значения переменных MUST NOT входить в ключ шага.

#### Scenario: Вторая попытка работы

- **WHEN** работа с `attempts: { max: 3 }` исполняет вторую попытку
- **THEN** окружение её шагов содержит `STEPCAST_JOB_ATTEMPT=2` и `STEPCAST_JOB_ATTEMPT_MAX=3`

#### Scenario: Работа без попыток

- **WHEN** работа не объявляет `attempts`
- **THEN** окружение её шагов содержит `STEPCAST_JOB_ATTEMPT=1` и `STEPCAST_JOB_ATTEMPT_MAX=1`

#### Scenario: Ключ шага не зависит от попытки

- **WHEN** один и тот же шаг исполняется в первой и во второй попытке работы
- **THEN** ключ шага в обеих попытках одинаков
