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
elif [ -d "$PROJECT/.git" ]; then
  # Репозиторий принадлежит приложению, и от root git с ним работать отказывается.
  sudo -u "$USER_NAME" -H bash -lc "cd '$PROJECT' && git pull --ff-only"
fi
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
  export STORE_DATA_DIR='$DATA_DIR' PORT='$PORT'
  pm2 describe istore >/dev/null 2>&1 && pm2 restart istore --update-env || pm2 start server.js --name istore
  pm2 save
"
# Дамп pm2 — единственное место, где живёт STORE_DATA_DIR, поэтому pm2 save
# обязателен после любого изменения, а после `pm2 update` нужен `pm2 resurrect`.
env PATH="/usr/local/bin:$PATH" pm2 startup systemd -u "$USER_NAME" --hp "/home/$USER_NAME" >/dev/null

say "Caddy: $DOMAIN → 127.0.0.1:$PORT"
# Сертификат и маршрут есть только у самого домена: без совпадения по имени Caddy
# не отдаёт сайт вовсе, поэтому по голому IP витрину не найти. Сжатие намеренно
# не включаем — Brotli/gzip приложение делает само.
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}

www.$DOMAIN {
	redir https://$DOMAIN{uri} permanent
}
CADDY
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
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
