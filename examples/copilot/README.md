# Приёмка адаптера Copilot

Живой прогон на установленном и залогиненном `copilot`
(`npm i -g @github/copilot`, затем `/login` в самом CLI). Тратит квоту
подписки: один короткий вызов модели.

## Почему из временного проекта

Адаптер поставляется плагином (`burnex/backends/copilot`), а не встроен. В
`.burnex/config.yml` этого репозитория он **не объявляется**: модуль лежит в
`dist/` рабочего дерева и до сборки не существует, а отказ загрузки плагина
прекращает любую команду. Поэтому приёмка идёт из отдельного каталога с
собственной конфигурацией.

## Как запускать

```bash
npm run build
```

```bash
T=$(mktemp -d) && mkdir -p "$T/.burnex" && printf 'plugins: ["%s/dist/src/parts/backends/copilot/index.js"]\ndefaults:\n  agent: copilot\n' "$PWD" > "$T/.burnex/config.yml" && git -C "$T" init -q && echo "$T"
```

```bash
cd "$T" && burnex config | grep copilot
```

Ожидается запись `backends.copilot.*` с источником `plugin:copilot`.

```bash
cd "$T" && burnex lint /путь/к/stepcast/examples/copilot/burnex.yml && burnex run /путь/к/stepcast/examples/copilot/burnex.yml
```

## Что сверить по журналу прогона

- статус работы и шага — `success`, в рабочем дереве есть `notes.txt`;
- `stdout.log` шага — ответ в два абзаца с пустой строкой между ними, без
  ANSI-кодов и сводки расхода (`-s`, `--no-color`);
- `step.json` без поля `session`, поля расхода несообщены;
- сколько шаг молчал до ответа — от этого зависит совет про
  `defaults.stall_timeout` в `docs/config.md`;
- события `backend.degraded` в журнале нет (в пайплайне нет ни `session: shared`,
  ни `effort`).
