#!/bin/sh
# Запускается от пользователя магазина; сохраняет все остальные задания.
set -eu
export LC_ALL=C
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT HUP INT TERM
if ! crontab -l > "$task_dir/before" 2> "$task_dir/error"; then
  if grep -q 'no crontab for' "$task_dir/error"; then
    exit 0
  fi
  cat "$task_dir/error" >&2
  exit 1
fi
awk '!/refresh-demo-reviews[.]sh|scripts\/demo-reviews[.]js|npm (run )?reviews:demo([ ;]|$)/' \
  "$task_dir/before" > "$task_dir/after"
if ! cmp -s "$task_dir/before" "$task_dir/after"; then
  crontab "$task_dir/after"
fi
