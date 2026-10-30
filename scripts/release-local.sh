#!/usr/bin/env bash
# Собирает stepcast из текущего рабочего каталога и публикует его как
# отдельный, независимый от дальнейших правок релиз, на который смотрит
# глобальная команда `stepcast`.
#
# Идея: /opt/homebrew/bin/stepcast указывает на
# ~/.stepcast/releases/current/dist/src/bin.js, а current — это symlink,
# который атомарно переключается на новую директорию релиза. Пересборка в
# рабочем каталоге (`npm run build`, `npm run dev` и т.п.) никак не трогает
# уже опубликованный релиз — глобальный stepcast, которым пользуется,
# например, прогон assertum, продолжает работать со старой версией, пока этот
# скрипт не будет запущен явно.
#
# Раскладку релиза (состав каталога, зависимости, переключение current) знает
# один install.sh; здесь остаётся сборка и имя релиза <ts>-<sha>[-dirty].
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# STEPCAST_RELEASES_DIR, как и прежде, — любой каталог: install.sh в режиме
# --from-dir берёт его вместо $STEPCAST_HOME/releases.
RELEASES_DIR="${STEPCAST_RELEASES_DIR:-${STEPCAST_HOME:-$HOME/.stepcast}/releases}"

cd "$REPO_DIR"

echo "==> npm run build"
npm run build

REV="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  DIRTY="-dirty"
fi
VERSION="$(date -u +%Y%m%dT%H%M%SZ)-${REV}${DIRTY}"

echo "==> Собираю независимый релиз $VERSION"
# Паспорт установки и лаунчер в этом режиме не трогаются: релиз из рабочего
# дерева — путь разработки, а не установка.
bash "$REPO_DIR/scripts/install.sh" --from-dir "$REPO_DIR" --name "$VERSION"

echo "==> Готово: $RELEASES_DIR/current -> $RELEASES_DIR/$VERSION"
echo "    Глобальный stepcast (если настроен через bin-symlink) уже использует новую версию."
