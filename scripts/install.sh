#!/usr/bin/env bash
# Устанавливает burnex: клонирует ссылку, собирает и раскладывает релиз в
# $BURNEX_HOME/releases/<имя>, переключает current и ставит лаунчер
# `burnex` в $BURNEX_BIN_DIR.
#
#   curl -fsSL https://raw.githubusercontent.com/assertumai/burnex/main/scripts/install.sh | bash
#   bash scripts/install.sh [--repo URL] [--ref REF] [--force]
#
# `burnex update` в режиме managed запускает копию этого скрипта из текущего
# релиза, поэтому флаги держатся обратно совместимыми. Флаги — в usage() ниже:
# при `curl … | bash` файла скрипта нет, и справку из комментария не прочесть.
set -euo pipefail

usage() {
  cat <<'EOF'
install.sh — установка burnex в $BURNEX_HOME/releases (по умолчанию ~/.burnex)
и лаунчер burnex в $BURNEX_BIN_DIR (по умолчанию ~/.local/bin).

  --repo URL     откуда клонировать (по умолчанию GitHub; подойдёт и путь)
  --ref REF      тег, ветка или sha; по умолчанию последний тег vX.Y.Z
  --force        заменить чужой файл на месте лаунчера
  --from-dir DIR разложить уже собранное дерево без клонирования
                 (только для scripts/release-local.sh; паспорт и лаунчер
                 не трогаются; каталог релизов можно задать BURNEX_RELEASES_DIR)
  --name NAME    имя релиза для --from-dir (иначе <ts>-from-dir)
EOF
}

DEFAULT_REPO="https://github.com/assertumai/burnex.git"
REPO="$DEFAULT_REPO"
REF=""
FORCE=0
FROM_DIR=""
NAME=""

# Прежние имена STEPCAST_* читаются один выпуск переходного периода.
# Домашний каталог по умолчанию — ~/.burnex; прежний ~/.stepcast без нового
# переименовывается, и на его месте остаётся ссылка: лаунчер и агент
# автозапуска установленного релиза указывают внутрь прежнего пути.
if [ -z "${BURNEX_HOME:-}" ] && [ -z "${STEPCAST_HOME:-}" ] && [ ! -e "$HOME/.burnex" ] && [ -d "$HOME/.stepcast" ] && [ ! -L "$HOME/.stepcast" ]; then
  mv "$HOME/.stepcast" "$HOME/.burnex"
  ln -s .burnex "$HOME/.stepcast"
  echo "==> домашний каталог ~/.stepcast переименован в ~/.burnex, на прежнем месте ссылка"
fi
BURNEX_HOME="${BURNEX_HOME:-${STEPCAST_HOME:-$HOME/.burnex}}"
BIN_DIR="${BURNEX_BIN_DIR:-${STEPCAST_BIN_DIR:-$HOME/.local/bin}}"
BURNEX_RELEASES_DIR="${BURNEX_RELEASES_DIR:-${STEPCAST_RELEASES_DIR:-}}"
RELEASES_DIR="$BURNEX_HOME/releases"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

need_arg() {
  [ "$#" -ge 2 ] || die "флагу $1 нужно значение"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) need_arg "$@"; REPO="$2"; shift 2 ;;
    --ref) need_arg "$@"; REF="$2"; shift 2 ;;
    --from-dir) need_arg "$@"; FROM_DIR="$2"; shift 2 ;;
    --name) need_arg "$@"; NAME="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "неизвестный флаг: $1" ;;
  esac
done

# release-local.sh исторически принимал любой каталог релизов. Только для
# --from-dir: у установки каталог релизов выводится из BURNEX_HOME и
# записывается в паспорт.
if [ -n "$FROM_DIR" ] && [ -n "$BURNEX_RELEASES_DIR" ]; then
  RELEASES_DIR="$BURNEX_RELEASES_DIR"
fi

command -v git >/dev/null 2>&1 || die "нужен git"
command -v npm >/dev/null 2>&1 || die "нужен npm"
command -v node >/dev/null 2>&1 || die "нужен Node.js >= 22.13"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 13) ? 0 : 1)' || die "нужен Node.js >= 22.13, найден $(node -v)"

# Временные каталоги убираются при любом выходе; current при сбое не трогается:
# он переключается последним шагом, после того как релиз полностью разложен.
WORK=""
STAGE=""
PASSPORT_TMP=""
cleanup() {
  [ -z "$WORK" ] || rm -rf "$WORK"
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  [ -z "$PASSPORT_TMP" ] || rm -f "$PASSPORT_TMP"
}
trap cleanup EXIT

STRICT_TAG='^v[0-9]+\.[0-9]+\.[0-9]+$'

# Чужой файл на месте лаунчера (например, `npm link`) — отказ до клонирования
# и сборки: минуты работы не должны кончаться отказом, известным заранее.
# Лаунчер — `burnex`. Прежний лаунчер `stepcast`, если это наша ссылка на
# релиз, убирается: псевдоним снят последним шагом переименования.
LAUNCHER="$BIN_DIR/burnex"
LEGACY_LAUNCHER="$BIN_DIR/stepcast"
check_launcher_free() {
  local launcher="$1"
  if [ -z "$FROM_DIR" ] && { [ -e "$launcher" ] || [ -L "$launcher" ]; }; then
    local ours=0
    if [ -L "$launcher" ]; then
      case "$(readlink "$launcher")" in
        "$RELEASES_DIR"/*|"$HOME/.stepcast/releases"/*) ours=1 ;;
      esac
    fi
    if [ "$ours" -eq 0 ]; then
      [ "$FORCE" -eq 1 ] || die "$launcher уже занят чужим файлом (npm link?); повторите с --force, чтобы заменить его"
      if [ -d "$launcher" ] && [ ! -L "$launcher" ]; then die "$launcher — каталог, заменять его нельзя"; fi
    fi
  fi
}
check_launcher_free "$LAUNCHER"

if [ -n "$FROM_DIR" ]; then
  SRC="$(cd "$FROM_DIR" && pwd)"
  [ -f "$SRC/dist/src/bin.js" ] || die "в $SRC нет dist/src/bin.js: сначала npm run build"
  [ -n "$NAME" ] || NAME="$(date -u +%Y%m%dT%H%M%SZ)-from-dir"
else
  if [ -z "$REF" ]; then
    # Пре-релизы vX.Y.Z-… отбрасываются строгим шаблоном: их ставят только явным --ref.
    TAGS="$(git ls-remote --tags --refs "$REPO" 'v*')" || die "не удалось получить теги из $REPO"
    REF="$(printf '%s\n' "$TAGS" \
      | sed 's|.*refs/tags/||' \
      | grep -E "$STRICT_TAG" \
      | sed 's/^v//' \
      | sort -t. -k1,1n -k2,2n -k3,3n \
      | tail -n 1 || true)"
    [ -n "$REF" ] || die "в $REPO нет тегов vX.Y.Z; укажите ссылку явно: --ref main"
    REF="v$REF"
  fi

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/burnex-install.XXXXXX")"
  SRC="$WORK/src"
  echo "==> Клонирую $REPO @ $REF"
  if ! git clone --quiet --depth 1 --branch "$REF" "$REPO" "$SRC" 2>/dev/null; then
    # --branch не берёт sha: добираем его отдельно.
    rm -rf "$SRC"
    git init --quiet "$SRC"
    git -C "$SRC" fetch --quiet --depth 1 "$REPO" "$REF" || die "не удалось получить $REF из $REPO"
    git -C "$SRC" checkout --quiet FETCH_HEAD
  fi

  # Вывод сборки молчит при успехе и печатается целиком при сбое: tsc пишет
  # ошибки в stdout, и `>/dev/null` оставил бы человека без причины.
  echo "==> npm ci"
  (cd "$SRC" && npm ci --no-audit --no-fund >"$WORK/ci.log" 2>&1) \
    || { cat "$WORK/ci.log" >&2; die "npm ci не удался"; }
  echo "==> npm run build"
  (cd "$SRC" && npm run build >"$WORK/build.log" 2>&1) \
    || { cat "$WORK/build.log" >&2; die "сборка не удалась"; }

  SRC_VERSION="$(node -p 'require(process.argv[1]).version' "$SRC/package.json")"
  if printf '%s' "$REF" | grep -Eq "$STRICT_TAG"; then
    # По тегу ставит этот скрипт, по версии — npm: расхождение дало бы две разные «0.3.0».
    [ "${REF#v}" = "$SRC_VERSION" ] \
      || die "тег $REF не совпадает с версией в package.json ($SRC_VERSION)"
    NAME="$SRC_VERSION"
  else
    SHORT_SHA="$(git -C "$SRC" rev-parse --short HEAD)"
    NAME="$(printf '%s' "$REF" | tr '/' '-')-$SHORT_SHA"
  fi
fi

FINAL="$RELEASES_DIR/$NAME"
STAGE="$RELEASES_DIR/$NAME.tmp-$$"
echo "==> Раскладываю релиз $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/src"
cp -R "$SRC/dist" "$STAGE/dist"
# tsc пишет bin.js как 0644, а лаунчер — симлинк прямо на него: без бита
# исполнения оболочка отвечает «permission denied: stepcast».
chmod +x "$STAGE/dist/src/bin.js"
cp -R "$SRC/schema" "$STAGE/schema"
# Файлы поставки (routes.yml, встроенные шаги и пайплайны) рантайм ищет по
# <корень пакета>/src/builtin — через tsc они не проходят.
cp -R "$SRC/src/builtin" "$STAGE/src/builtin"
cp "$SRC/package.json" "$SRC/package-lock.json" "$STAGE/"
# Исходник лежит в scripts/ (границы правок репозитория), в релизе — в корне. Копия — то, что запускает `burnex update`.
cp "$SRC/scripts/install.sh" "$STAGE/install.sh"

echo "==> npm ci --omit=dev"
npm ci --omit=dev --prefix "$STAGE" --no-audit --no-fund >/dev/null

# Повтор той же версии пересобирает каталог: частично разложенный релиз от
# прерванной установки иначе жил бы вечно. Прежний каталог отодвигается, а не
# удаляется заранее, чтобы current не висел в пустоту дольше одного mv.
OLD=""
if [ -e "$FINAL" ]; then
  OLD="$FINAL.old-$$"
  mv "$FINAL" "$OLD"
fi
if ! mv "$STAGE" "$FINAL"; then
  [ -z "$OLD" ] || mv "$OLD" "$FINAL"
  die "не удалось перенести релиз на место: $FINAL"
fi
STAGE=""
[ -z "$OLD" ] || rm -rf "$OLD"

# ln -sfn меняет саму ссылку current, а не то, на что она указывает: пара
# `ln current.tmp` + `mv` на macOS перемещала бы current.tmp внутрь каталога.
ln -sfn "$FINAL" "$RELEASES_DIR/current"
echo "==> current -> $FINAL"

if [ -n "$FROM_DIR" ]; then
  exit 0
fi

mkdir -p "$BIN_DIR"
ln -sfn "$RELEASES_DIR/current/dist/src/bin.js" "$LAUNCHER"
echo "==> лаунчер: $LAUNCHER -> $RELEASES_DIR/current/dist/src/bin.js"
if [ -L "$LEGACY_LAUNCHER" ]; then
  case "$(readlink "$LEGACY_LAUNCHER")" in
    "$RELEASES_DIR"/*|"$HOME/.stepcast/releases"/*|"$HOME/.burnex/releases"/*)
      rm -f "$LEGACY_LAUNCHER"
      echo "==> прежний лаунчер $LEGACY_LAUNCHER убран: команда называется burnex" ;;
  esac
fi

# Паспорт пишется последним и атомарно: по нему `burnex update` узнаёт
# способ установки, а полупрозрачный файл хуже отсутствующего.
mkdir -p "$BURNEX_HOME"
PASSPORT_TMP="$BURNEX_HOME/install.json.tmp-$$"
# bin_dir нужен `burnex update`: без него обновление нестандартной установки
# поставило бы второй лаунчер в ~/.local/bin.
INSTALL_REPO="$REPO" INSTALL_REF="$REF" INSTALL_VERSION="$SRC_VERSION" INSTALL_RELEASES="$RELEASES_DIR" \
INSTALL_BIN_DIR="$BIN_DIR" \
INSTALL_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  node -e 'const e = process.env; console.log(JSON.stringify({
    method: "managed", repo: e.INSTALL_REPO, ref: e.INSTALL_REF, version: e.INSTALL_VERSION,
    releases_dir: e.INSTALL_RELEASES, bin_dir: e.INSTALL_BIN_DIR, installed_at: e.INSTALL_AT }, null, 2))' > "$PASSPORT_TMP"
mv "$PASSPORT_TMP" "$BURNEX_HOME/install.json"
PASSPORT_TMP=""

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Каталога $BIN_DIR нет в PATH. Добавьте в профиль оболочки:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Готово: burnex $SRC_VERSION"
