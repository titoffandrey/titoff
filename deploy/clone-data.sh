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
#
# КАК ЭТО ЕДЕТ ЧЕРЕЗ TOR, И ПОЧЕМУ НЕ ОДНИМ scp. Первый перенос (14 сентября
# 2026: 2,4 ГБ, 33 тысячи файлов) одним scp шёл на 140 КБ/с — пять часов в одну
# сторону, а обрыв цепочки (у onion это обычное дело) начинал бы всё заново.
# Одна цепочка Tor и есть предел: шесть узлов, у каждого своя полоса. Поэтому:
#   · экспорт и заливка запускаются на серверах ОТВЯЗАННЫМИ от SSH-сессии
#     (setsid nohup) и ждутся опросом — сорвавшаяся сессия их не убьёт и не
#     оставит заливку сделанной наполовину;
#   · архив режется на JOBS частей, и каждая едет по СВОЕЙ цепочке Tor: у Tor
#     разные логин/пароль SOCKS означают разные цепочки (IsolateSOCKSAuth), а
#     логин умеет передавать deploy/tor-socks.py — nc из ~/.ssh/config не умеет;
#   · каждая часть идёт `rsync --partial --append` с повторами: обрыв
#     докачивается с места, а не с нуля;
#   · части уезжают на новый сервер ПО МЕРЕ ПРИХОДА, а не после всего архива —
#     два этапа идут внахлёст;
#   · sha256 сверяется у каждой части и у собранного архива на обоих концах.
# Замер: 12 цепочек дают 300–500 КБ/с суммарно против 140 у одной. Серверы при
# этом друг друга не касаются — всё идёт через ноутбук, и это не случайность:
# сайты на этом коде — разные магазины, и адресов друг друга знать не должны.
set -uo pipefail

FROM="${1:-}"
TO="${2:-}"
shift 2 2>/dev/null || true
FLAGS="$*"
JOBS="${JOBS:-12}"

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
PROXY="$ROOT/deploy/tor-socks.py"
STAMP="$(date -u '+%Y%m%d-%H%M%S')"
LOCAL_DIR="$ROOT/data-transfer"
PARTS="$LOCAL_DIR/parts-$FROM-$STAMP"
LOCAL="$LOCAL_DIR/store-$FROM-$STAMP.tgz"
REMOTE='/home/titoff/store-transfer.tgz'
RPARTS='/home/titoff/store-transfer.parts'
ON_SERVER="cd /home/titoff/istore && STORE_DATA_DIR=/var/lib/apple-store /usr/local/bin/node"
mkdir -p "$PARTS"
command -v rsync >/dev/null || { echo 'Нужен rsync.'; exit 1; }
command -v python3 >/dev/null || { echo 'Нужен python3 (для deploy/tor-socks.py).'; exit 1; }

# ssh по алиасу, но через СВОЮ цепочку Tor: логин SOCKS — метка цепочки.
# Каждый вызов с новой меткой — новая цепочка, поэтому повтор после обрыва не
# упирается в ту же застрявшую.
tssh() { # tssh <алиас> <метка> <команда…>
  local alias="$1" tag="$2"; shift 2
  ssh -o BatchMode=yes -o ConnectTimeout=40 -o ProxyCommand="$PROXY $tag %h %p" "$alias" "$@"
}
# То же с повторами: Tor рвёт соединения, и одна неудача — не ответ.
# Вывод печатается только у удавшейся попытки: сорвавшаяся могла успеть
# отдать полстроки, и склеенные хвосты двух заходов читались бы как один ответ.
retry() { # retry <попыток> <алиас> <метка> <команда…>
  local n="$1" alias="$2" tag="$3"; shift 3
  local i out
  for i in $(seq 1 "$n"); do
    if out="$(tssh "$alias" "$tag-$i" "$@")"; then printf '%s\n' "$out"; return 0; fi
    sleep $((5 + RANDOM % 10))
  done
  return 1
}
sha_local() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

echo "== $FROM: собираю архив (отвязанным процессом, жду опросом)"
retry 5 "$FROM" exp-start "rm -rf /var/lib/apple-store/export-* '$REMOTE' '$REMOTE'.*.tmp '$RPARTS'; \
  setsid nohup sudo -u titoff -H bash -lc '$ON_SERVER scripts/export-store.js --out $REMOTE' \
    > /home/titoff/store-export.log 2>&1 < /dev/null & sleep 2; echo запущено" \
  || { echo 'Экспорт не запустился.'; exit 1; }
for i in $(seq 1 90); do
  if tssh "$FROM" "exp-wait-$i" "test -f '$REMOTE' && grep -q 'Архив записан' /home/titoff/store-export.log" 2>/dev/null; then break; fi
  [ "$i" = 90 ] && { echo 'Экспорт не завершился за полчаса — смотрите /home/titoff/store-export.log на исходном сервере.'; exit 1; }
  sleep 20
done
retry 5 "$FROM" exp-log "cat /home/titoff/store-export.log"

echo "== $FROM: режу архив на $JOBS частей"
retry 5 "$FROM" split "cd /home/titoff && rm -rf '$RPARTS' && mkdir '$RPARTS' && split -n $JOBS -d -a 2 '$REMOTE' '$RPARTS'/part. \
  && (cd '$RPARTS' && sha256sum part.* > sums) && sha256sum '$REMOTE' | awk '{print \$1}' > '$RPARTS'/whole.sha256 && ls '$RPARTS' | wc -l" \
  || { echo 'Не удалось разрезать архив.'; exit 1; }
retry 5 "$FROM" sums "cat '$RPARTS'/sums" > "$PARTS/sums" || { echo 'Не забрал суммы частей.'; exit 1; }
WHOLE_SHA="$(retry 5 "$FROM" whole "cat '$RPARTS'/whole.sha256")" || { echo 'Не забрал сумму архива.'; exit 1; }
echo "   sha256 архива: $WHOLE_SHA"
PART_NAMES="$(awk '{print $2}' "$PARTS/sums")"

# Часть: докачать с исходного сервера → сверить → отправить на новый. Всё по
# своей цепочке, всё с повторами; сверка после докачки — единственный судья.
move_part() { # move_part <имя части>
  local name="$1" i want have
  for i in $(seq 1 80); do
    rsync --partial --append --timeout=120 \
      -e "ssh -o BatchMode=yes -o ConnectTimeout=40 -o ProxyCommand=\"$PROXY get-$name-$i %h %p\"" \
      "$FROM:$RPARTS/$name" "$PARTS/$name" 2>>"$PARTS/$name.err" && break
    [ "$i" = 80 ] && { echo "   $name: НЕ ДОКАЧАНА"; return 1; }
    sleep $((5 + RANDOM % 10))
  done
  want="$(awk -v f="$name" '$2==f{print $1}' "$PARTS/sums")"
  have="$(sha_local "$PARTS/$name")"
  [ "$want" = "$have" ] || { echo "   $name: СУММА НЕ СОШЛАСЬ после докачки"; return 1; }
  echo "   $name: докачана и сверена, отправляю на $TO"
  for i in $(seq 1 80); do
    rsync --partial --append --timeout=120 \
      -e "ssh -o BatchMode=yes -o ConnectTimeout=40 -o ProxyCommand=\"$PROXY put-$name-$i %h %p\"" \
      "$PARTS/$name" "$TO:$RPARTS/$name" 2>>"$PARTS/$name.err" && { echo "   $name: отправлена"; return 0; }
    sleep $((5 + RANDOM % 10))
  done
  echo "   $name: НЕ ОТПРАВЛЕНА"; return 1
}

echo "== $FROM → ноутбук → $TO: $JOBS частей параллельно, каждая по своей цепочке"
retry 5 "$TO" mk "rm -rf '$RPARTS' && mkdir -p '$RPARTS'" || { echo "Не удалось подготовить каталог на $TO."; exit 1; }
FAILED=0
for name in $PART_NAMES; do move_part "$name" & done
for job in $(jobs -p); do wait "$job" || FAILED=$((FAILED + 1)); done
[ "$FAILED" = 0 ] || { echo "Не доехало частей: $FAILED. Части и суммы лежат в $PARTS — повторный запуск начнёт заново."; exit 1; }

echo "== ноутбук: собираю архив ($LOCAL)"
cat "$PARTS"/part.* > "$LOCAL"
HAVE="$(sha_local "$LOCAL")"
[ "$HAVE" = "$WHOLE_SHA" ] || { echo "sha256 собранного архива не сошлась: $HAVE"; exit 1; }
rm -rf "$PARTS"
ls -la "$LOCAL"

echo "== $TO: собираю архив и сверяю"
DEST_SHA="$(retry 5 "$TO" assemble "cd '$RPARTS' && cat part.* > '$REMOTE' && chown titoff:titoff '$REMOTE' && rm -rf '$RPARTS' && sha256sum '$REMOTE' | awk '{print \$1}'")" \
  || { echo "Не удалось собрать архив на $TO."; exit 1; }
[ "$DEST_SHA" = "$WHOLE_SHA" ] || { echo "sha256 на $TO не сошлась: $DEST_SHA — архив там битый, заливка не начиналась."; exit 1; }
echo "   сошлось: $DEST_SHA"
retry 5 "$FROM" clean "rm -rf '$RPARTS' '$REMOTE' /home/titoff/store-export.log" >/dev/null

echo "== $TO: что изменится"
retry 5 "$TO" plan "sudo -u titoff -H bash -lc '$ON_SERVER scripts/import-store.js $REMOTE $FLAGS'" || { echo "Предпросмотр заливки не прошёл."; exit 1; }

echo "== $TO: записываю (отвязанным процессом, жду опросом)"
# `pm2 restart` без `--update-env`: окружение процесса (STORE_DATA_DIR,
# PUBLIC_ORIGIN) живёт в дампе pm2, а в этой оболочке его нет — обновлять
# оттуда значило бы затереть его пустотой.
retry 5 "$TO" imp-start "rm -f /home/titoff/store-import.log; setsid nohup sudo -u titoff -H bash -lc \
  '$ON_SERVER scripts/import-store.js $REMOTE --apply $FLAGS && pm2 restart istore >/dev/null && echo IMPORT-OK || echo IMPORT-FAIL' \
  > /home/titoff/store-import.log 2>&1 < /dev/null & sleep 2; echo запущено" \
  || { echo 'Заливка не запустилась.'; exit 1; }
for i in $(seq 1 60); do
  if tssh "$TO" "imp-wait-$i" "grep -qE 'IMPORT-(OK|FAIL)' /home/titoff/store-import.log" 2>/dev/null; then break; fi
  [ "$i" = 60 ] && { echo 'Заливка не завершилась за двадцать минут — смотрите /home/titoff/store-import.log на новом сервере.'; exit 1; }
  sleep 20
done
retry 5 "$TO" imp-log "cat /home/titoff/store-import.log"
if ! tssh "$TO" imp-check "grep -q IMPORT-OK /home/titoff/store-import.log"; then
  echo "ЗАЛИВКА НЕ ПРОШЛА — см. лог выше. Архив на $TO оставлен: $REMOTE"
  exit 1
fi
retry 5 "$TO" imp-clean "rm -f '$REMOTE' /home/titoff/store-import.log" >/dev/null

echo "== $TO: витрина"
retry 5 "$TO" check 'curl -s -o /dev/null -w "локальная витрина отвечает: %{http_code}\n" http://127.0.0.1:3000/'

cat <<DONE

Готово. Архив остался на ноутбуке: $LOCAL
Дальше — в панели нового сайта (/admin → Настройки): название, логотип, контакты,
реквизиты, Telegram, кассы; пароль панели приехал со старого сайта — смените.
DONE
