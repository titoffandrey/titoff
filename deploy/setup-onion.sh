#!/bin/bash
# Первичная настройка нового сервера: SSH-ключ, onion-служба только для SSH, файрвол.
# В консоли хостера набирать длинные строки нечем — вставка в текстовый tty невозможна,
# поэтому вся настройка приезжает сюда одной короткой командой:
#
#   curl -sL <ссылка> | bash
#
# Скрипт идемпотентен: повторный запуск ничего не ломает.
set -euo pipefail

KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHJoROpTC90dT9Gfxbd1QyuxZOHCMmsEYt6wr8NtmxaO istore2-onion-2026-08-08'

[ "$(id -u)" -eq 0 ] || { echo 'Нужен root'; exit 1; }

echo '== Ставлю tor, ufw, qrencode'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq tor ufw qrencode

echo '== Кладу SSH-ключ'
mkdir -p /root/.ssh && chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
# Сверяем по телу ключа, а не по всей строке: комментарий может отличаться
BODY=$(awk '{print $2}' <<<"$KEY")
grep -qF "$BODY" /root/.ssh/authorized_keys || echo "$KEY" >> /root/.ssh/authorized_keys

echo '== Onion-служба: наружу проброшен только SSH'
if ! grep -q '^HiddenServiceDir /var/lib/tor/ssh/' /etc/tor/torrc; then
  printf '\nHiddenServiceDir /var/lib/tor/ssh/\nHiddenServicePort 22 127.0.0.1:22\n' >> /etc/tor/torrc
fi
systemctl enable tor >/dev/null 2>&1 || true
systemctl restart tor

echo '== Файрвол: снаружи закрыто всё, 22-й порт тоже'
# Пароль на вход не включаем вовсе, а публичный 22 закрываем: SSH остаётся
# доступен только через onion, который ходит по петле (её ufw пропускает всегда).
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw --force enable >/dev/null

echo '== Жду onion-адрес'
for _ in $(seq 1 90); do
  [ -s /var/lib/tor/ssh/hostname ] && break
  sleep 1
done

if [ ! -s /var/lib/tor/ssh/hostname ]; then
  echo 'Tor не отдал адрес. Смотри: journalctl -u tor@default -n 40 --no-pager'
  exit 1
fi

ONION=$(cat /var/lib/tor/ssh/hostname)

echo
echo '=========================== ONION ==========================='
qrencode -t ANSIUTF8 -m 1 "$ONION" 2>/dev/null || true
echo
echo "$ONION" | sed 's/.\{8\}/& /g'
echo
echo '--- отпечаток хост-ключа (сверить при первом подключении) ---'
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print $2}'
echo '============================================================='
