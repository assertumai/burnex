## ADDED Requirements

### Requirement: Манифест несёт происхождение запуска по расписанию
`stepcast run` SHALL принимать флаги `--scheduled <ISO-момент>`, `--schedule-entry <N>` и `--catchup` и при их наличии записывать в `run.json` поле `trigger` со значениями `kind: schedule`, номером записи `entry`, выражением `cron` и поясом `timezone` этой записи раскрытого пайплайна, моментом `moment` и признаком `catchup`. Флаги `--scheduled` и `--schedule-entry` MUST задаваться только вместе, `--catchup` — только с ними; неразборчивый момент, номер записи вне `triggers.schedule` и запись, которую отклонил бы линт, MUST отклоняться до создания каталога прогона с названной причиной. Прогон без этих флагов и прогон, полученный `stepcast resume`, MUST NOT нести поле `trigger`.

#### Scenario: Запуск по расписанию
- **WHEN** выполняется `stepcast run --pipeline p.yml --scheduled 2026-11-02T03:00:00+01:00 --schedule-entry 0` для пайплайна, чья запись 0 — `0 3 * * *` в поясе `Europe/Berlin`
- **THEN** `run.json` несёт `trigger` с `kind: schedule`, `entry: 0`, `cron: "0 3 * * *"`, `timezone: Europe/Berlin`, этим моментом и `catchup: false`

#### Scenario: Догон
- **WHEN** к тем же флагам добавлен `--catchup`
- **THEN** `run.json` несёт `trigger` с `catchup: true`

#### Scenario: Номер записи вне расписания
- **WHEN** `--schedule-entry 3` задан для пайплайна с одной записью расписания
- **THEN** запуск отклоняется до создания каталога прогона с причиной, называющей номер записи

#### Scenario: Флаг без пары
- **WHEN** задан `--catchup` без `--scheduled` или `--scheduled` без `--schedule-entry`
- **THEN** запуск отклоняется с причиной, называющей недостающий флаг

#### Scenario: Ручной прогон и возобновление
- **WHEN** прогон запущен без этих флагов или получен `stepcast resume` из прогона с `trigger`
- **THEN** его `run.json` не несёт поля `trigger`

#### Scenario: Прежний манифест
- **WHEN** читается манифест, записанный до появления поля
- **THEN** он читается как прежде, и прогон считается запущенным не по расписанию
