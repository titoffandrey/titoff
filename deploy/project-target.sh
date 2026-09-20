#!/bin/bash
# Общая проверка назначения: и обёртка, и прямой install используют её.
# Один независимый репозиторий может публиковать только один магазин.

load_project_target() {
  local root="$1" row_alias row_domain extra count=0
  local list="$root/deploy/sites.txt"
  [ -f "$list" ] || {
    echo 'Нет deploy/sites.txt. Скопируйте deploy/sites.example.txt и укажите один сайт.' >&2
    return 1
  }
  while read -r row_alias row_domain extra || [ -n "$row_alias" ]; do
    case "$row_alias" in ''|'#'*) continue;; esac
    count=$((count + 1))
    if [ -n "$extra" ] || [[ ! "$row_alias" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] \
      || [[ ! "$row_domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
      echo 'Некорректная строка deploy/sites.txt: нужны SSH-алиас и домен.' >&2
      return 1
    fi
    TARGET_ALIAS="$row_alias"
    TARGET_DOMAIN="$row_domain"
  done < "$list"
  [ "$count" = 1 ] || {
    echo 'СТОП. deploy/sites.txt должен содержать ровно один сайт этого проекта.' >&2
    return 1
  }
  PROJECT_ID="$(cat "$root/deploy/project-id" 2>/dev/null)" || {
    echo 'Нет deploy/project-id: проект не привязан к своей выкатке.' >&2
    return 1
  }
  [[ "$PROJECT_ID" =~ ^[a-f0-9]{32}$ ]] || {
    echo 'Некорректный deploy/project-id.' >&2
    return 1
  }
}

require_project_target() {
  [ "$1" = "$TARGET_ALIAS" ] && [ "$2" = "$TARGET_DOMAIN" ] || {
    echo 'СТОП. Этот сервер или домен не принадлежит локальному проекту.' >&2
    return 1
  }
}

require_tor_alias() {
  if ! ssh -G "$TARGET_ALIAS" 2>/dev/null | grep -qi '^proxycommand.*\(socks\|9150\|9050\|torsocks\|nc \)'; then
    echo 'СТОП. У SSH-алиаса проекта нет прокси через Tor.' >&2
    return 1
  fi
}

require_remote_project() {
  local owner
  owner="$(ssh -o BatchMode=yes "$TARGET_ALIAS" 'cat /var/lib/apple-store/deploy-project-id 2>/dev/null')" || {
    echo 'СТОП. Привязка проекта на сервере не прочитана. Для первого подключения используйте deploy/bind-project.sh.' >&2
    return 1
  }
  [ "$owner" = "$PROJECT_ID" ] || {
    echo 'СТОП. Сервер закреплён за другим проектом. Выкатка запрещена.' >&2
    return 1
  }
}
