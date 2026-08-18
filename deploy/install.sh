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

# Без git-url зальём текущее рабочее дерево — так удобнее выкатывать правку,
# которой ещё нет в удалённом репозитории.
if [ -z "$REPO" ]; then
  echo "== Заливаю текущее дерево проекта на $ALIAS"
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  # Только то, что нужно для запуска: данные, фото и сборочный мусор остаются дома.
  tar -czf - -C "$ROOT" \
    --exclude='./data' --exclude='./.git' --exclude='./apple_svg' --exclude='./node_modules' \
    --exclude='./.DS_Store' --exclude='*.tmp' . \
    | ssh -o BatchMode=yes "$ALIAS" \
      'set -e; id -u titoff >/dev/null 2>&1 || adduser --disabled-password --gecos "" titoff;
       mkdir -p /home/titoff/istore && tar -xzf - -C /home/titoff/istore && chown -R titoff:titoff /home/titoff/istore'
fi

echo "== Разворачиваю магазин на домене $DOMAIN"
ssh -o BatchMode=yes "$ALIAS" "DOMAIN='$DOMAIN' REPO='$REPO' bash -s" < "$(dirname "$0")/setup-server.sh"

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
