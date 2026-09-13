#!/bin/bash
# Перенос каталога, фотографий и отзывов с одного сервера на другой —
# запускается С НОУТБУКА, при открытом Tor Browser.
#
#   ./deploy/clone-data.sh <алиас-откуда> <алиас-куда> [--keep-settings] [--force]
#
# Например, второй сайт с каталогом первого:
#   ./deploy/clone-data.sh istore2-onion istore3-onion
#
# Что происходит:
#   1. на исходном сервере `scripts/export-store.js` собирает архив: товары с
#      фото (вместе с уменьшенными копиями), отзывы со вложениями, настройки;
#   2. архив приезжает на ноутбук (deploy/../data-transfer/, в git не идёт) —
#      это заодно и резервная копия каталога;
#   3. на новом сервере `scripts/import-store.js --apply` раскладывает его по
#      каталогу данных и перезапускает процесс.
#
# Заказы, переписка чата, метрика и правила посетителей НЕ переносятся — это
# покупатели старого сайта, а не товар. Название, контакты, реквизиты продавца,
# Telegram и ключи касс по умолчанию сбрасываются: второй сайт — другой
# магазин, и стартует он в режиме заявок, пока владелец не заполнит настройки.
# `--keep-settings` переносит настройки буквально (переезд ТОГО ЖЕ магазина на
# другую машину); `--force` разрешает заливку поверх сервера, который уже
# торговал. Оба флага — про import-store.js, см. его шапку.
#
# Новый сервер к этому моменту уже должен быть установлен (`deploy/install.sh`)
# и запущен: заливка идёт в /var/lib/apple-store под пользователем titoff.
set -euo pipefail

FROM="${1:-}"
TO="${2:-}"
shift 2 2>/dev/null || true
FLAGS="$*"

if [ -z "$FROM" ] || [ -z "$TO" ]; then
  sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
[ "$FROM" != "$TO" ] || { echo 'Откуда и куда — один и тот же сервер.'; exit 1; }

# Оба алиаса обязаны идти через Tor — то же правило, что у install.sh: голое
# имя хоста здесь ровно то, чего мы избегаем.
for A in "$FROM" "$TO"; do
  if ! ssh -G "$A" 2>/dev/null | grep -qi '^proxycommand.*\(socks\|9150\|9050\|torsocks\|nc \)'; then
    echo "У алиаса «$A» в ~/.ssh/config нет прокси через Tor. Поправьте конфиг и повторите."
    exit 1
  fi
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="$ROOT/data-transfer"
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
LOCAL="$LOCAL_DIR/store-$FROM-$STAMP.tgz"
REMOTE='/home/titoff/store-transfer.tgz'
ON_SERVER="cd /home/titoff/istore && STORE_DATA_DIR=/var/lib/apple-store /usr/local/bin/node"
mkdir -p "$LOCAL_DIR"

echo "== $FROM: собираю архив"
ssh -o BatchMode=yes "$FROM" "sudo -u titoff -H bash -lc '$ON_SERVER scripts/export-store.js --out $REMOTE'"

echo "== $FROM → ноутбук: $LOCAL"
scp -o BatchMode=yes "$FROM:$REMOTE" "$LOCAL"
ssh -o BatchMode=yes "$FROM" "rm -f '$REMOTE'"
ls -la "$LOCAL"

echo "== ноутбук → $TO"
scp -o BatchMode=yes "$LOCAL" "$TO:$REMOTE"
ssh -o BatchMode=yes "$TO" "chown titoff:titoff '$REMOTE'"

echo "== $TO: что изменится"
ssh -o BatchMode=yes "$TO" "sudo -u titoff -H bash -lc '$ON_SERVER scripts/import-store.js $REMOTE $FLAGS'"

echo "== $TO: записываю"
# `pm2 restart` без `--update-env`: окружение процесса (STORE_DATA_DIR,
# PUBLIC_ORIGIN) живёт в дампе pm2, а в этой оболочке его нет — обновлять
# оттуда значило бы затереть его пустотой.
ssh -o BatchMode=yes "$TO" "sudo -u titoff -H bash -lc '$ON_SERVER scripts/import-store.js $REMOTE --apply $FLAGS && pm2 restart istore >/dev/null'; rm -f '$REMOTE'"

echo "== $TO: витрина"
ssh -o BatchMode=yes "$TO" 'curl -s -o /dev/null -w "локальная витрина отвечает: %{http_code}\n" http://127.0.0.1:3000/'

cat <<DONE

Готово. Архив остался на ноутбуке: $LOCAL
Дальше — в панели нового сайта (/admin → Настройки): название, логотип, контакты,
реквизиты, Telegram, кассы; пароль панели приехал со старого сайта — смените.
DONE
