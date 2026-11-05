#!/usr/bin/env bash
# Ведёт петлю саморазвития без человека: собирает движок из последнего коммита
# ветки копии, запускает заход .burnex/pipelines/self-improve.yml и
# повторяет, пока заходы что-то коммитят в ветку.
#
# Запуск (на macOS — под caffeinate, иначе машина уснёт посреди ночи):
#
#   caffeinate -i bash scripts/self-improve-loop.sh
#
# Переменные:
#   MAX_RUNS                  потолок итераций, по умолчанию 20
#   BURNEX_LOOP_ENGINE_DIR  каталог worktree движка; по умолчанию
#                             <git common dir>/burnex-loop-engine;
#                             относительный путь считается от текущего каталога
#
# Каждая итерация идёт на движке, собранном из коммита, а не из рабочего
# дерева копии: сведённое итерацией N улучшение работает уже в итерации N+1, а
# незакоммиченные правки человека в движок не попадают. Заход получает
# `--input onto=<ветка копии>`: сведение ждёт чистой копии само, поэтому
# грязная копия не останавливает петлю, и чистоту здесь не проверяет никто.
#
# Остановка и код выхода:
#   0       исчерпан MAX_RUNS; либо итерация ничего не закоммитила, а прогон
#           завершился успешно (в том числе пустая очередь)
#   <код>   итерация ничего не закоммитила, прогон завершился с этим кодом
#   1       упала подготовка worktree, npm ci или сборка; либо вершина ветки
#           перестала читаться (ветку удалили или переименовали посреди петли)
#   2       отказ на старте: отделённый HEAD, имя ветки вне [A-Za-z0-9._/-],
#           неверный MAX_RUNS, нет sha256
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && git rev-parse --show-toplevel)"
MAX_RUNS="${MAX_RUNS:-20}"
ITERATIONS=0

stop() {
  local code="$1" reason="$2"
  echo "self-improve-loop: остановка — $reason (итераций выполнено: $ITERATIONS)" >&2
  exit "$code"
}

if ! BRANCH="$(git -C "$REPO_DIR" symbolic-ref --short HEAD 2>/dev/null)"; then
  stop 2 "HEAD копии отделён, сводить некуда"
fi

# Имя ветки доезжает до `sh -c` работ slots и merge подстановкой
# ${params.onto}, а подстановка не экранирует: git допускает в именах веток
# и `$`, и `;`, и кавычки. Набор шире этого не пропускается вовсе.
if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  stop 2 "имя ветки «$BRANCH» вне набора [A-Za-z0-9._/-], подставлять его в команду небезопасно"
fi

# Строка с ведущим нулём ("08") в арифметике bash читалась бы как восьмеричная.
if [[ ! "$MAX_RUNS" =~ ^[0-9]+$ ]] || (( 10#$MAX_RUNS <= 0 )); then
  stop 2 "MAX_RUNS должен быть положительным целым, получено «$MAX_RUNS»"
fi
MAX_RUNS=$((10#$MAX_RUNS))

if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  stop 2 "нет ни shasum, ни sha256sum"
fi

# Внутри .git каталог не видят ни git status, ни ESLint, ни tsc копии.
# Путь делается абсолютным сразу: git -C "$REPO_DIR" worktree add считал бы
# относительный от корня копии, а [ -d ] и cd — от текущего каталога.
# Прежнее имя STEPCAST_LOOP_ENGINE_DIR читается один выпуск переходного периода.
BURNEX_LOOP_ENGINE_DIR="${BURNEX_LOOP_ENGINE_DIR:-${STEPCAST_LOOP_ENGINE_DIR:-}}"
if [ -n "$BURNEX_LOOP_ENGINE_DIR" ]; then
  case "$BURNEX_LOOP_ENGINE_DIR" in
    /*) ENGINE_DIR="$BURNEX_LOOP_ENGINE_DIR" ;;
    *) ENGINE_DIR="$PWD/$BURNEX_LOOP_ENGINE_DIR" ;;
  esac
else
  ENGINE_DIR="$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir)/burnex-loop-engine"
fi
LOCK_SHA_FILE="$ENGINE_DIR/.burnex-loop-lock.sha"

branch_tip() { git -C "$REPO_DIR" rev-parse --verify --quiet "refs/heads/$BRANCH"; }

# Движок — коммит плюс собранное из него: --force возвращает отслеживаемые
# файлы к коммиту, а dist/ (в .gitignore, его --force не трогает) стирается
# перед сборкой, чтобы осиротевший .js переехавшего исходника не пережил
# итерацию. git clean не зовётся нарочно — он стёр бы и node_modules, и
# отпечаток lockfile, ради которых worktree постоянный.
prepare_engine() {
  local tip="$1"
  if [ ! -d "$ENGINE_DIR" ]; then
    # Каталог, удалённый руками, git всё ещё помнит как worktree, и add без
    # prune отказывал бы на каждом запуске.
    git -C "$REPO_DIR" worktree prune >&2 || return 1
    git -C "$REPO_DIR" worktree add --detach "$ENGINE_DIR" "$tip" >&2 || return 1
  fi
  git -C "$ENGINE_DIR" checkout --detach --force "$tip" >&2 || return 1

  local lock_sha
  lock_sha="$(sha256 "$ENGINE_DIR/package-lock.json")" || return 1
  if [ ! -d "$ENGINE_DIR/node_modules" ] || [ ! -f "$LOCK_SHA_FILE" ] \
    || [ "$(cat "$LOCK_SHA_FILE")" != "$lock_sha" ]; then
    # Отпечаток снимается до npm ci и пишется только после его успеха:
    # упавшая установка не должна выглядеть установленной.
    rm -f "$LOCK_SHA_FILE"
    (cd "$ENGINE_DIR" && npm ci --no-audit --no-fund) >&2 || return 1
    printf '%s\n' "$lock_sha" > "$LOCK_SHA_FILE"
  fi
  rm -rf "$ENGINE_DIR/dist"
  (cd "$ENGINE_DIR" && npm run build) >&2 || return 1
  # tsc не ставит бит исполнения, а шаги зовут движок через $BURNEX_BIN напрямую.
  chmod +x "$ENGINE_DIR/dist/src/bin.js" || return 1
}

for ((i = 1; i <= MAX_RUNS; i++)); do
  before="$(branch_tip)" || stop 1 "вершина ветки $BRANCH не читается"
  echo "self-improve-loop: итерация $i из $MAX_RUNS, ветка $BRANCH, вершина ${before:0:12}" >&2

  if ! prepare_engine "$before"; then
    stop 1 "не удалась подготовка движка (worktree, npm ci или сборка)"
  fi

  # Код прогона нужен значением, а не падением скрипта.
  run_code=0
  (cd "$REPO_DIR" && node "$ENGINE_DIR/dist/src/bin.js" run .burnex/pipelines/self-improve.yml --input "onto=$BRANCH") \
    || run_code=$?
  ITERATIONS=$i

  after="$(branch_tip)" || stop 1 "вершина ветки $BRANCH не читается после прогона (код прогона $run_code)"
  echo "self-improve-loop: итерация $i — код прогона $run_code, вершина ${before:0:12}..${after:0:12}" >&2

  # Условие остановки — сдвиг вершины, а не код прогона: заход, у которого
  # дорожка свелась, а finalize отметил что-то красным, ветку всё же сдвинул.
  if [ "$before" = "$after" ]; then
    stop "$run_code" "прогон ничего не закоммитил"
  fi
done

stop 0 "исчерпан MAX_RUNS"
