#!/bin/bash
# Разворачивает магазин на чистом сервере под указанным доменом.
#
# Запускается НА СЕРВЕРЕ под root. Обычно его не набирают руками — его приносит
# `deploy/install.sh` с ноутбука:
#
#   ./deploy/install.sh <ssh-алиас> <домен> [git-url]
#
# Вручную (когда репозиторий уже лежит на сервере):
#   DOMAIN=shop.example bash deploy/setup-server.sh
#
# Скрипт идемпотентен: повторный запуск ничего не ломает и данные не трогает.
# Он НЕ настраивает SSH и onion — это делает deploy/setup-onion.sh в консоли
# хостера ещё до первого подключения.
set -euo pipefail

DOMAIN="${DOMAIN:-${1:-}}"
REPO="${REPO:-}"                      # git-url; пусто — код уже лежит в $PROJECT
USER_NAME="${STORE_USER:-titoff}"     # под кем работает приложение
PROJECT="${PROJECT:-/home/$USER_NAME/istore}"
DATA_DIR="${DATA_DIR:-/var/lib/apple-store}"
PORT="${PORT:-3000}"
NODE_VERSION="${NODE_VERSION:-22.11.0}"

[ "$(id -u)" -eq 0 ] || { echo 'Нужен root'; exit 1; }
[ -n "$DOMAIN" ] || { echo 'Укажите домен: DOMAIN=shop.example bash deploy/setup-server.sh'; exit 1; }
# Домен уезжает в Caddyfile, а тот исполняется — проверяем, что это имя, а не строка.
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]] \
  || { echo "Домен «$DOMAIN» не похож на имя"; exit 1; }

say() { printf '\n== %s\n' "$1"; }

say "Пользователь $USER_NAME"
id -u "$USER_NAME" >/dev/null 2>&1 || adduser --disabled-password --gecos '' "$USER_NAME"

say 'Пакеты: caddy, imagemagick, git'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# ImageMagick обязателен и его отсутствие ничем не проявляется: без него фото
# просто остаются исходниками на несколько мегабайт (см. lib/images.js).
apt-get install -y -qq git curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https imagemagick webp
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# Node ставим тарболом с nodejs.org: дистрибутивный пакет отстаёт на годы, а
# systemd-юнит pm2 берёт node из PATH, где /usr/local/bin идёт первым.
say "Node $NODE_VERSION"
if ! /usr/local/bin/node -v 2>/dev/null | grep -q "^v${NODE_VERSION%%.*}\."; then
  ARCH=$(dpkg --print-architecture); case "$ARCH" in amd64) NARCH=x64;; arm64) NARCH=arm64;; *) echo "Неизвестная архитектура $ARCH"; exit 1;; esac
  TMP=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NARCH.tar.xz" -o "$TMP/node.tar.xz"
  tar -xJf "$TMP/node.tar.xz" -C "$TMP"
  cp -a "$TMP/node-v$NODE_VERSION-linux-$NARCH/." /usr/local/
  rm -rf "$TMP"
fi
/usr/local/bin/node -v

say "Код в $PROJECT"
if [ -n "$REPO" ] && [ ! -d "$PROJECT/.git" ]; then
  sudo -u "$USER_NAME" -H git clone "$REPO" "$PROJECT"
elif [ -n "$REPO" ] && [ -d "$PROJECT/.git" ]; then
  # Репозиторий принадлежит приложению, и от root git с ним работать отказывается.
  sudo -u "$USER_NAME" -H bash -lc "cd '$PROJECT' && git pull --ff-only"
fi
# БЕЗ `REPO` КОД УЖЕ ЗАЛИТ RSYNC'ом (install.sh без git-url — обычный путь
# выкатки правки, которой ещё нет в удалённом репозитории), и `git pull` здесь
# не просто лишний, а вредный: залитые файлы для git — «локальные изменения», и
# `--ff-only` падает на них с «your local changes would be overwritten», обрывая
# скрипт до перезапуска pm2. Витрина при этом остаётся на старом коде, а выкатка
# выглядит прошедшей наполовину. Тянуть из репозитория имеет смысл ровно тогда,
# когда его и просили — то есть при заданном `REPO`.
[ -f "$PROJECT/server.js" ] || { echo "В $PROJECT нет server.js — укажите REPO=<git-url>"; exit 1; }

# Данные живут ВНЕ проекта: git pull их не трогает, а бэкап делается одной папкой.
say "Хранилище $DATA_DIR"
mkdir -p "$DATA_DIR/backups"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"
chmod 700 "$DATA_DIR"

say 'PM2'
/usr/local/bin/npm install -g pm2 --silent >/dev/null
sudo -u "$USER_NAME" -H bash -lc "
  set -e
  cd '$PROJECT'
  export STORE_DATA_DIR='$DATA_DIR' PORT='$PORT' PUBLIC_ORIGIN='https://$DOMAIN'
  pm2 describe istore >/dev/null 2>&1 && pm2 restart istore --update-env || pm2 start server.js --name istore
  pm2 save
"
# Дамп pm2 — единственное место, где живёт STORE_DATA_DIR, поэтому pm2 save
# обязателен после любого изменения, а после `pm2 update` нужен `pm2 resurrect`.
env PATH="/usr/local/bin:$PATH" pm2 startup systemd -u "$USER_NAME" --hp "/home/$USER_NAME" >/dev/null

say "Caddy: $DOMAIN → 127.0.0.1:$PORT"
# Свой блок есть только у основного домена: он обязан работать и тогда, когда
# приложение остановлено. Сжатие намеренно не включаем — Brotli/gzip приложение
# делает само.
#
# Последний блок — дополнительные домены, привязанные в панели («Домены
# магазина»). Сертификат им выдаётся по требованию, и перед каждым выпуском
# Caddy спрашивает приложение, своё ли это имя (`/internal/tls-ask`,
# `lib/domains.js`). Поэтому привязка домена не требует ни правки этого файла,
# ни перезапуска Caddy.
#
# По голому IP витрину по-прежнему не найти: `ask` отвечает отказом всему, чего
# нет в списке, а IP там не бывает вовсе — приложение не считает адрес доменом.
#
# ФАЙЛ С МЕТКОЙ РУЧНОЙ ПРАВКИ НЕ ПЕРЕЗАПИСЫВАЕТСЯ. Обычно этот скрипт и есть
# источник конфига прокси, и переписывать его набело правильно. Но у машины с
# НЕСКОЛЬКИМИ адресами блоки привязываются к своему IP (`bind`), и такой конфиг
# отсюда не собрать: он знает про адреса, которых скрипт не спрашивает. Слепая
# перезапись погасила бы домен на втором адресе целиком — своего блока у него
# не осталось бы, а в списке «Домены магазина» его и не должно быть, потому что
# тот список обслуживает блок по требованию на основном адресе. Домен просто
# перестал бы открываться, и связать это с выкаткой было бы нечем.
KEEP_MARK='ПРАВЛЕНО РУКАМИ'
if [ -f /etc/caddy/Caddyfile ] && grep -q "$KEEP_MARK" /etc/caddy/Caddyfile; then
say "Caddyfile помечен «$KEEP_MARK» — оставляю как есть, конфиг прокси не трогаю"
else
cat > /etc/caddy/Caddyfile <<CADDY
{
	on_demand_tls {
		ask http://127.0.0.1:$PORT/internal/tls-ask
	}
}

$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}

https:// {
	tls {
		on_demand
	}
	@www header_regexp host Host ^www\.(.+)\$
	redir @www https://{re.host.1}{uri} permanent
	reverse_proxy 127.0.0.1:$PORT
}
CADDY
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
fi
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say 'Файрвол: наружу только 80 и 443'
# 22-й порт снаружи закрыт намеренно: SSH доступен только через onion, а он
# ходит по петле, которую ufw пропускает всегда.
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
fi

say 'Ежедневное обновление дат демо-отзывов'
# Даты считаются от релиза до «сегодня»: без обновления самый свежий отзыв через
# месяц окажется месячной давности и витрина будет выглядеть заброшенной.
CRON="20 1 * * * { date -Is; STORE_DATA_DIR=$DATA_DIR NODE_BIN=/usr/local/bin/node $PROJECT/scripts/refresh-demo-reviews.sh; } >> /home/$USER_NAME/demo-reviews.log 2>&1"
sudo -u "$USER_NAME" -H bash -lc "(crontab -l 2>/dev/null | grep -v refresh-demo-reviews.sh; echo '$CRON') | crontab -"

say 'База пунктов выдачи и её ежедневное обновление'
# Отдельным заданием, а не вместе с отзывами: здесь ходят в чужой сервис по сети,
# и его недоступность не должна ронять обновление дат отзывов.
# Первый прогон делаем сразу — иначе на свежем сервере ближайшие пункты не
# предлагались бы до первой ночи, и понять почему было бы неоткуда.
CRON_PVZ="40 2 * * * { date -Is; cd $PROJECT && STORE_DATA_DIR=$DATA_DIR /usr/local/bin/node scripts/sync-pickup-points.js --apply; } >> /home/$USER_NAME/pickup-points.log 2>&1"
sudo -u "$USER_NAME" -H bash -lc "(crontab -l 2>/dev/null | grep -v sync-pickup-points.js; echo '$CRON_PVZ') | crontab -"
# Списка может не быть (нет сети, сервис недоступен) — это не повод обрывать
# установку: витрина работает и без подсказки ближайших пунктов.
sudo -u "$USER_NAME" -H bash -lc "cd $PROJECT && STORE_DATA_DIR=$DATA_DIR /usr/local/bin/node scripts/sync-pickup-points.js --apply" \
  || echo 'список пунктов выдачи не скачался — обновится ночью по cron'

say 'Проверка'
sleep 2
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || echo '000')
echo "локальная витрина отвечает: $CODE"
[ "$CODE" = '200' ] || { echo 'Витрина не поднялась. Смотрите: pm2 logs istore --lines 50'; exit 1; }

cat <<DONE

=================================================================
  Магазин развёрнут: https://$DOMAIN
  Панель:            https://$DOMAIN/admin   (по умолчанию admin / admin)

  СМЕНИТЕ ПАРОЛЬ СРАЗУ — в панели «Настройки» → «Доступ в панель».
  Забыт пароль:
    echo -n 'новый-пароль' | sudo -u $USER_NAME STORE_DATA_DIR=$DATA_DIR \\
      /usr/local/bin/node $PROJECT/scripts/reset-admin-password.js

  Название, слоган, логотип, цвета, реквизиты, Telegram и ключ кассы —
  там же, в «Настройках»: домен на них больше не влияет.

  A-запись домена должна указывать на этот сервер — иначе Let's Encrypt
  не выпустит сертификат (проверить: journalctl -u caddy -n 30).
=================================================================
DONE
