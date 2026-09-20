#!/bin/bash
# Историческое имя сохранено; команда выкатывает только сайт этого проекта.
# Назначение — одна строка deploy/sites.txt (образец: sites.example.txt).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/deploy/project-target.sh"
load_project_target "$ROOT"
if [ "$#" -gt 1 ] || { [ "$#" = 1 ] && [ "$1" != "$TARGET_DOMAIN" ]; }; then
  echo 'СТОП. Можно выкатить только единственный сайт этого проекта.' >&2
  exit 1
fi
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && [ "${FORCE_DEPLOY:-}" != 1 ]; then
  echo 'СТОП. В рабочем дереве есть незакоммиченные правки — сначала закоммитьте их.' >&2
  exit 1
fi
exec "$ROOT/deploy/install.sh" "$TARGET_ALIAS" "$TARGET_DOMAIN" </dev/null
