#!/bin/bash
# Установка магазина на новый VPS — запускается С НОУТБУКА.
#
#   ./deploy/install.sh <ssh-алиас> <домен> [git-url]
#
# Например:
#   ./deploy/install.sh istore3-onion shop.example git@github.com:me/istore.git
#
# Что должно быть сделано ДО этого:
#   1. VPS арендован, домен куплен, A-запись домена указывает на его адрес;
#   2. в консоли хостера (noVNC/SPICE) выполнен deploy/setup-onion.sh — он ставит
#      SSH-ключ и поднимает onion-службу только для 22-го порта;
#   3. полученный onion-адрес добавлен в ~/.ssh/config тем же алиасом, что и
#      istore2-onion: через SOCKS Tor Browser, БЕЗ отката на прямой IP;
#   4. Tor Browser открыт и соединение установлено.
#
# Подключаемся только по алиасу и только через Tor. Прямой IP не используем
# нигде: связка «наш ноутбук → этот сервер» не должна появляться ни в одном логе.
set -euo pipefail

ALIAS="${1:-}"
DOMAIN="${2:-}"
REPO="${3:-}"

if [ -z "$ALIAS" ] || [ -z "$DOMAIN" ]; then
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

# Алиас обязан быть настроен в ~/.ssh/config: только там прописан прокси через
# Tor. Голое имя хоста или IP в аргументе — это как раз то, чего мы избегаем.
if ! ssh -G "$ALIAS" 2>/dev/null | grep -qi '^proxycommand.*\(socks\|9150\|9050\|torsocks\|nc \)'; then
  echo "У алиаса «$ALIAS» в ~/.ssh/config нет прокси через Tor."
  echo 'Подключаться к серверу магазина напрямую нельзя. Поправьте конфиг и повторите.'
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Откуда выкачен сервер. Файл лежит в каталоге ДАННЫХ, а не проекта: проект
# перезаписывается заливкой, данные — никогда.
MARK='/var/lib/apple-store/deployed-from.txt'

# ЗАЛИВКА ИДЁТ ПОВЕРХ, И БЕЗ ЭТОЙ ПРОВЕРКИ ОНА МОЛЧА СТИРАЕТ ЧУЖУЮ РАБОТУ.
#
# tar распаковывается в существующий каталог: файла, которого нет в архиве, он
# не тронет, а файл, который есть, перезапишет целиком. Поэтому дерево, не
# содержащее уже выкаченной работы, убирает её с витрины — при этом сама
# выкатка проходит успешно и ничего не говорит.
#
# Так 4 сентября 2026 с витрины пропали страница «О компании» и правки подвала:
# они жили в ветке `claude/serene-borg-946d1b`, не влитой в main, а выкатка шла
# из дерева, отведённого от main. Случилось это не впервые — в истории сервера
# лежит стеш «до-выкатки-подвала-2026-08-31» с тем же следом.
#
# Узнать это по самому серверу было нельзя: `.git` заливка исключает, и HEAD
# там показывает давний коммит, никак не связанный с тем, что реально лежит в
# файлах. Отсюда отдельная отметка — сервер помнит, из какого коммита выкачен.
if [ -z "$REPO" ]; then
  HEAD_NOW="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
  PREV_LINE="$(ssh -o BatchMode=yes "$ALIAS" "cat '$MARK' 2>/dev/null || true" | head -1)"
  PREV_COMMIT="${PREV_LINE%% *}"

  if [ -n "$PREV_COMMIT" ] && [ -n "$HEAD_NOW" ] && [ "${FORCE_DEPLOY:-}" != '1' ]; then
    if ! git -C "$ROOT" cat-file -e "${PREV_COMMIT}^{commit}" 2>/dev/null; then
      echo "СТОП. На сервере выкачен коммит $PREV_COMMIT, которого нет в этом репозитории."
      echo "Скорее всего выкатывали с другой машины или из непринесённой ветки."
      echo 'Сделайте git fetch --all и повторите; осознанно затереть — FORCE_DEPLOY=1.'
      exit 1
    fi
    if ! git -C "$ROOT" merge-base --is-ancestor "$PREV_COMMIT" "$HEAD_NOW"; then
      echo "СТОП. Это дерево НЕ содержит того, что уже выкачено на сервер."
      echo "Выкачено: $PREV_LINE"
      echo 'Пропадёт с витрины:'
      git -C "$ROOT" log --oneline "$HEAD_NOW..$PREV_COMMIT" | sed 's/^/  /' | head -20
      echo
      echo 'Сначала влейте это в своё дерево:'
      echo "  git merge $PREV_COMMIT"
      echo 'Осознанно затереть — FORCE_DEPLOY=1.'
      exit 1
    fi
  fi

  # Незакоммиченное на сервере восстановить неоткуда — предупреждаем вслух.
  case "$PREV_LINE" in
    *' dirty '*)
      echo "ВНИМАНИЕ: прошлая выкатка шла из дерева с незакоммиченными правками."
      echo "  $PREV_LINE"
      echo '  Их в git нет, и если они нужны — заберите их с сервера до заливки.'
      ;;
  esac
fi

# Без git-url зальём текущее рабочее дерево — так удобнее выкатывать правку,
# которой ещё нет в удалённом репозитории.
if [ -z "$REPO" ]; then
  echo "== Заливаю текущее дерево проекта на $ALIAS"
  # Только то, что нужно для запуска: данные, фото и сборочный мусор остаются дома.
  COPYFILE_DISABLE=1 tar --no-xattrs -czf - -C "$ROOT" \
    --exclude='./data' --exclude='./.git' --exclude='./apple_svg' --exclude='./apple-photos' \
    --exclude='./node_modules' --exclude='./.DS_Store' --exclude='._*' --exclude='*.tmp' . \
    | ssh -o BatchMode=yes "$ALIAS" \
      'set -e; id -u titoff >/dev/null 2>&1 || adduser --disabled-password --gecos "" titoff;
       mkdir -p /home/titoff/istore && tar -xzf - -C /home/titoff/istore && chown -R titoff:titoff /home/titoff/istore'
fi

echo "== Разворачиваю магазин на домене $DOMAIN"
ssh -o BatchMode=yes "$ALIAS" "DOMAIN='$DOMAIN' REPO='$REPO' bash -s" < "$(dirname "$0")/setup-server.sh"

# Запоминаем, из чего выкачено, — этим живёт проверка выше. Пишем ПОСЛЕ
# успешной установки: отметка о выкатке, которая не дошла, хуже её отсутствия.
if [ -z "$REPO" ]; then
  DEPLOY_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo 'unknown')"
  DEPLOY_BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '-')"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    DEPLOY_STATE='dirty'
  else
    DEPLOY_STATE='clean'
  fi
  {
    echo "$DEPLOY_COMMIT $DEPLOY_BRANCH $DEPLOY_STATE $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    git -C "$ROOT" status --porcelain 2>/dev/null | sed 's/^/  /' | head -40
  } | ssh -o BatchMode=yes "$ALIAS" "mkdir -p \"\$(dirname '$MARK')\" && cat > '$MARK'"
fi

cat <<DONE

Готово. Дальше:
  · откройте https://$DOMAIN/admin и смените пароль в «Настройках»;
  · там же задайте название, слоган, логотип, цвета и реквизиты продавца;
  · ключ подсказок адресов и ключи кассы — в тех же «Настройках».

Проверять витрину с этого ноутбука напрямую нельзя. Только изнутри сервера:
  ssh $ALIAS 'curl -s -o /dev/null -w "%{http_code}\\n" localhost:3000/'
или через Tor-SOCKS:
  curl --socks5-hostname 127.0.0.1:9150 -s -o /dev/null -w '%{http_code}\\n' https://$DOMAIN/
DONE
