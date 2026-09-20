#!/bin/bash
# Однократная привязка сервера к независимому репозиторию.
# Аргумент — проверенный commit из deployed-from.txt; new — только пустой VPS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/deploy/project-target.sh"
load_project_target "$ROOT"
EXPECTED="${1:-}"
if [ "$#" != 1 ] || { [ "$EXPECTED" != new ] && [[ ! "$EXPECTED" =~ ^[a-f0-9]{40}$ ]]; }; then
  echo 'Использование: ./deploy/bind-project.sh <проверенный выкаченный commit | new>' >&2
  exit 1
fi
if [ "$EXPECTED" != new ]; then
  git -C "$ROOT" cat-file -e "${EXPECTED}^{commit}"
  git -C "$ROOT" merge-base --is-ancestor "$EXPECTED" HEAD || {
    echo 'СТОП. Проект не содержит проверенный серверный commit.' >&2
    exit 1
  }
fi
require_tor_alias
ssh -o BatchMode=yes "$TARGET_ALIAS" "PROJECT_ID='$PROJECT_ID' EXPECTED='$EXPECTED' bash -s" <<'REMOTE'
set -euo pipefail
DIR=/var/lib/apple-store
OWNER="$DIR/deploy-project-id"
if [ -e "$OWNER" ]; then
  [ "$(cat "$OWNER")" = "$PROJECT_ID" ] || {
    echo 'СТОП. Сервер уже закреплён за другим проектом.' >&2
    exit 1
  }
  echo 'Сервер уже закреплён за этим проектом.'
  exit 0
fi
if [ "$EXPECTED" = new ]; then
  if [ -e "$DIR/deployed-from.txt" ] || [ -e "$DIR/settings.json" ] || [ -e /home/titoff/istore/server.js ]; then
    echo 'СТОП. На сервере уже есть магазин; требуется его проверенный commit.' >&2
    exit 1
  fi
else
  read -r actual _ < "$DIR/deployed-from.txt"
  [ "$actual" = "$EXPECTED" ] || {
    echo 'СТОП. Выкаченный commit изменился; сначала проверьте сервер.' >&2
    exit 1
  }
fi
mkdir -p "$DIR"
umask 077
# noclobber не даст двум разным привязкам одновременно присвоить сервер.
(set -o noclobber; printf '%s\n' "$PROJECT_ID" > "$OWNER")
echo 'Сервер закреплён за проектом. Код и данные магазина не менялись.'
REMOTE
