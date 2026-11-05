import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CliIo } from '../src/kernel/cli/args.js';
import { run as runCli } from '../src/parts/cli/main.js';
import { ExitCode, type ExitCodeValue } from '../src/kernel/errors.js';
import { makeProject, withHome, type Project } from './helpers.js';

/**
 * Эталон дословного текста справки и кодов возврата, снятый с нынешнего
 * вывода до переезда команд в строки дерева (`cli-commands-as-rows`). Этот
 * тест после переезда не правится — его совпадение и есть приёмка задач 6 и
 * 8 (`openspec/changes/cli-commands-as-rows/tasks.md`).
 */

interface Outcome {
  readonly code: ExitCodeValue;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(project: Project, argv: readonly string[]): Promise<Outcome> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    cwd: project.root,
  };
  const code = await withHome(project.home, () => runCli(argv, io));
  return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

const HELP_TEXT = `ошибка: Не указана команда
    burnex run <pipeline> — выполнить пайплайн
      --input — значение входа пайплайна: --input имя=значение
      --env — переопределить объявленную переменную env пайплайна на этот прогон: --env ИМЯ=значение
      --dry-run — только проверить, не запуская работы
      --shadow — исполнить локальное, а действия шагов с external: true записать, не совершая (external обязателен у каждого шага)
      --agent — бэкенд агента на этот прогон — слой флага над defaults.agent; агент шага или работы документа, pipeline_agents и step_agents сильнее флага, агент корня документа — только при agent_policy: force
      --scheduled — пометить прогон как запущенный по расписанию в этот момент ISO 8601 с поясом (только с --schedule-entry)
      --schedule-entry — номер записи triggers.schedule, по которой запущен прогон (только с --scheduled)
      --catchup — прогон — догон пропущенного момента (только с --scheduled)
      --quiet — не печатать ход прогона
  burnex resume <run> — возобновить прогон, переиспользовав шаги с совпавшим ключом
      --from — начать заново с работы или шага: --from job[/step]
      --set — переопределить вход: --set имя=значение
      --dry-run — показать план, ничего не исполняя
  burnex diff <run-a> <run-b> — сравнить два прогона по ключам шагов, промптам, контексту и деревьям
  burnex decide <run> <outcome> — принять решение по ожиданию прогона: burnex decide <run> <исход>
      --step — адрес ожидающего шага (job или job/step) — обязателен при нескольких ожиданиях
      --reason — причина отклонения — обязательна для исхода с эффектом reject
      --from — точка перезапуска job[/step] — обязательна для исхода с эффектом restart
  burnex propose <target> — предложить правку файла кабинета проекта: burnex propose <цель> --from <файл> — единственный писатель очереди
      --from — файл с содержимым предложения — без него читается стандартный ввод
      --reason — причина предложения, необязательна
  burnex widgets — печатать состав виджетов проекта: имя, файл, голые импорты и неразрешимые по действующей таблице
      --json — печатать тот же состав машинным JSON
  burnex apply <run> — наложить результат изолированного прогона на текущее дерево
      --job — наложить только результат этой работы
      --lane — наложить только результат этой дорожки, одним диффом
      --force — снять отказ в повторном наложении дорожки, чей записанный исход — «сведена»
  burnex lint <pipeline> — статически проверить пайплайн, ничего не запуская
      --input — значение входа пайплайна: --input имя=значение
  burnex status — показать состояние прогона
      --run — идентификатор прогона, по умолчанию последний
      --explain — объяснить по каждому шагу, будет ли он переиспользован при возобновлении
  burnex logs <run> <job/step> — показать логи прогона или шага
      --follow — продолжать показывать вывод по мере записи
  burnex config — показать действующую конфигурацию и происхождение каждого значения
      --model — переопределить модель по умолчанию
      --agent — переопределить бэкенд по умолчанию
      --pipeline — раскрыть пайплайн (путь или stepcast:<имя>) и показать агента, модель и effort каждого шага с источником
  burnex schema — записать в .stepcast/schema/ JSON Schema документов проекта, знающую предикаты загруженных плагинов
      --out — каталог вывода вместо .stepcast/schema/
  burnex plugins — печатать осмотр дерева плагинов: место, id, слой, модуль, состояние, сервисы и вклады
      --dump — то же самое — флаг ради совместимости, поведение команды от него не зависит
      --json — печатать ту же модель осмотра машинным JSON, без единой строки сверх
  burnex package <action> <name> — пакеты пользователя: list — перечень со статусом, new <имя> — заготовка пакета, см. docs/packages.md
      --json — list: печатать перечень машинным JSON
      --home — new: завести пакет в слое home, а не проекта
  burnex gc — уборка: две отдельные цели — файлы прогонов (умолчание) и записи хранилища расхода (--stats); без ключей только отчёт
      --older-than — удалить прогоны (или, вместе с --stats, записи) старше этой длительности, например 30d
      --stats — снять записи хранилища расхода вместо файлов прогонов; --failed и --project действуют только с ним
      --failed — отбирать отказавшие прогоны — только вместе с --stats
      --project — ограничить отбор ключом проекта — только вместе с --stats
  burnex init — создать stepcast.yml и пример работы в текущем каталоге
      --force — перезаписать существующий stepcast.yml
      --knowledge — развернуть практику памяти вместо пайплайна: fs — встроенный источник
  burnex context <pipeline> — показать состав и размер контекста шага без запуска пайплайна
      --job — работа, для которой считается контекст
      --step — шаг, для которого считается контекст
      --input — значение входа пайплайна: --input имя=значение
  burnex up — поднять витрину: наблюдение за всеми прогонами в браузере
      --foreground — держать сервер в текущем терминале, не отсоединяя его
      --install — поставить демон на автозапуск через launchd (только macOS)
  burnex down — остановить витрину
      --uninstall — заодно убрать автозапуск через launchd (только macOS)
  burnex update — обновить движок тем способом, каким он поставлен (managed, checkout, npm)
      --ref — ссылка вместо последнего тега; для npm — версия или dist-tag
      --no-restart — не перезапускать демон витрины после обновления
  burnex usage <run> — показать расход прогона по работам, шагам и попыткам
  burnex backlog <action> <slug> — вести очередь улучшений backlog.md: list|pick|finish|settle|add|show, см. docs/backlog.md
      --file — путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге
      --slots — pick: сколько пунктов взять за раз, по умолчанию 1
      --lanes — pick: раздать по дорожкам, имена через запятую — a,b
      --only — pick: взять именно этот пункт по слагу, а не первый свободный по очерёдности
      --stale-hours — pick: порог давности зависшего in_progress в часах, по умолчанию 6; для пунктов без владельца или с владельцем, о котором не судить
      --run-dir — pick --lanes: каталог для файлов item-<дорожка>.json на каждую заполненную дорожку; settle: тот же каталог, обязателен; show: записать пункт в item-a.json этого каталога
      --owner — pick: записать владельца пункта run:<id прогона>; finish: проставить исход, только если пункт не забран другим прогоном
      --status — finish: исход done либо failed; add: статус нового пункта, todo (по умолчанию) либо postponed
      --title — add: заголовок пункта, обязателен
      --why — add: зачем пункт нужен, обязателен
      --done-when — add: по чему пункт признаётся выполненным, обязателен
      --group — add: слаг группы смежности
      --track — add: метка веса, например express
      --needs — add: слаги зависимостей через запятую
      --goal — add: путь файла цели от каталога очереди
      --details — add: пути файлов подробностей через запятую
      --after — add: поставить пункт сразу за этим пунктом, по умолчанию в конец
      --reason — finish --status failed: причина отказа
  burnex knowledge <action> — читать и проверять память репозитория: index|select|check|write, см. docs/knowledge.md
      --scope — select: области через запятую — src/**,test/**
      --id — select: идентификаторы через запятую
      --file — write: файл с описанием единицы знания
      --stdin — write: читать описание со стандартного ввода
      --json — вывести ответ источника как есть, машинным JSON
      --publish — check: опубликовать данными работы ключом true/false — есть ли среди нарушений index-overflow; только внутри шага прогона
      --record — check: датировать обнаруженные расхождения по якорям — без этого ключа check дерева не правит
  burnex data <action> <key> <value> — опубликовать данные работы, видимые в витрине и подстановкой \${jobs.<работа>.data.<ключ>}: set|merge|get
      --json — merge: объект вида {"ключ": "значение"}, дописываемый поверх опубликованного
  burnex merge-lanes <run> — свести названные дорожки прогона в дерево запуска: наложить, проверить, закоммитить зелёную
      --lanes — перечень дорожек через запятую, обязателен
      --check — команда проверки объединённого дерева, обязателен
      --file — путь к файлу очереди, по умолчанию backlog.md в рабочем каталоге
      --onto — свести на текущую вершину этой ветки под merge lock’ом, а не на стартовый коммит прогона
      --keep-claim — с --onto: несведённый пункт остаётся in_progress за прогоном, а не получает failed
  burnex assert-clean — проверить чистоту каталога запуска и объявленных вложенных репозиториев (project.nested_repos), ничего не правя
      --allow — пути, правки которых чистоту не нарушают, через запятую
  burnex project <action> — repos: дополнить документ дорожек (backlog pick --lanes) объявлениями репозиториев конфигурации
      --file — repos: файл с документом дорожек вместо стандартного ввода`;

describe('cli-help-baseline: эталон справки и кодов возврата до переезда команд в строки', () => {
  it('stepcast без аргументов печатает справку дословно и отказывает кодом ошибки конфигурации', async () => {
    const outcome = await cli(makeProject({}), []);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, HELP_TEXT);
  });

  it('stepcast --help печатает ту же справку дословно, тем же кодом возврата', async () => {
    const outcome = await cli(makeProject({}), ['--help']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, HELP_TEXT);
  });

  it('неизвестная команда: код возврата — ошибка конфигурации, справка приложена', async () => {
    const outcome = await cli(makeProject({}), ['frobnicate']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(outcome.stderr, HELP_TEXT.replace('Не указана команда', 'Неизвестная команда: frobnicate'));
  });

  it('неизвестный флаг команды: код возврата — ошибка конфигурации, справка сужена до одной команды', async () => {
    const outcome = await cli(makeProject({}), ['run', '--bogus', 'x']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(
      outcome.stderr,
      'ошибка: Неизвестный флаг --bogus у команды run\n' +
        '    burnex run <pipeline> — выполнить пайплайн\n' +
        '      --input — значение входа пайплайна: --input имя=значение\n' +
        '      --env — переопределить объявленную переменную env пайплайна на этот прогон: --env ИМЯ=значение\n' +
        '      --dry-run — только проверить, не запуская работы\n' +
        '      --shadow — исполнить локальное, а действия шагов с external: true записать, не совершая (external обязателен у каждого шага)\n' +
        '      --agent — бэкенд агента на этот прогон — слой флага над defaults.agent; агент шага или работы документа, pipeline_agents и step_agents сильнее флага, агент корня документа — только при agent_policy: force\n' +
        '      --scheduled — пометить прогон как запущенный по расписанию в этот момент ISO 8601 с поясом (только с --schedule-entry)\n' +
        '      --schedule-entry — номер записи triggers.schedule, по которой запущен прогон (только с --scheduled)\n' +
        '      --catchup — прогон — догон пропущенного момента (только с --scheduled)\n' +
        '      --quiet — не печатать ход прогона',
    );
  });

  it('лишний позиционный аргумент: код возврата — ошибка конфигурации, названо ожидаемое число аргументов', async () => {
    const outcome = await cli(makeProject({}), ['down', 'extra']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.equal(
      outcome.stderr,
      'ошибка: Команда down принимает не больше 0 позиционных аргументов, получено 1\n' +
        '    burnex down — остановить витрину\n' +
        '      --uninstall — заодно убрать автозапуск через launchd (только macOS)',
    );
  });

  it('отказ команды (файл пайплайна не найден): код возврата — ошибка конфигурации, названо место', async () => {
    const project = makeProject({});
    const outcome = await cli(project, ['run', 'nonexistent.yml']);
    assert.equal(outcome.code, ExitCode.configError);
    assert.equal(outcome.stdout, '');
    assert.match(outcome.stderr, /^ошибка: Файл не найден: /);
    assert.match(outcome.stderr, /nonexistent\.yml/);
  });
});
