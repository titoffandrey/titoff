#!/bin/bash
# «No space left on device» на свежем сервере: у облачного образа корневой раздел
# нередко остаётся размером с сам образ и не растягивается на весь диск.
# Скрипт показывает картину, освобождает место, растягивает раздел, чинит
# прерванный dpkg и, если места стало достаточно, продолжает настройку onion.
#
#   curl -sLo /tmp/f.sh <ссылка> && bash /tmp/f.sh
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo 'Нужен root'; exit 1; }

echo '=== БЫЛО ==='
df -h /
lsblk
echo

echo '=== Чищу кэши ==='
apt-get clean || true
rm -f /var/cache/apt/archives/*.deb 2>/dev/null || true
journalctl --vacuum-size=10M >/dev/null 2>&1 || true

echo '=== Растягиваю корневой раздел ==='
ROOT_SRC=$(findmnt -no SOURCE /)
echo "корень: $ROOT_SRC"
DISK=$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -1)
PART=$(grep -o '[0-9]*$' <<<"$ROOT_SRC")
if [ -n "$DISK" ] && [ -n "$PART" ]; then
  # growpart отвечает NOCHANGE, если раздел уже во весь диск — это не ошибка
  growpart "/dev/$DISK" "$PART" || true
  resize2fs "$ROOT_SRC" || true
else
  echo 'Не определил диск автоматически — покажи вывод lsblk выше'
fi

echo '=== Чиню прерванный dpkg ==='
dpkg --configure -a || true
apt-get -f install -y || true

echo '=== СТАЛО ==='
df -h /
echo

FREE=$(df -k --output=avail / | tail -1)
if [ "$FREE" -lt 1048576 ]; then
  echo "Свободно меньше 1 ГБ ($((FREE / 1024)) МБ). Дальше не иду, покажи вывод выше."
  exit 1
fi

echo '=== Места хватает, продолжаю настройку onion ==='
curl -sL https://raw.githubusercontent.com/titoffandrey/titoff/main/setup-onion.sh | bash
