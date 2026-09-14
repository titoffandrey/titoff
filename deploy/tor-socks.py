#!/usr/bin/env python3
# ProxyCommand для ssh: SOCKS5 через Tor Browser (127.0.0.1:9150) С ЛОГИНОМ.
#
# Зачем свой, когда есть `nc -X 5`: nc логин в SOCKS не передаёт, а Tor
# строит на каждую пару «логин/пароль» СВОЮ цепочку (IsolateSOCKSAuth — у
# Tor Browser включено). Так несколько параллельных ssh идут разными путями,
# а не делят одну медленную цепочку; одна цепочка до onion — это 140 КБ/с и
# пять часов на 2,4 ГБ (замер 14 сентября 2026), двенадцать — втрое-вчетверо
# больше суммарно. Логин Tor не проверяет, он для него только метка.
#
#   ssh -o ProxyCommand='deploy/tor-socks.py <логин> %h %p' <алиас>
#
# Адрес SOCKS — переменная TOR_SOCKS (по умолчанию 127.0.0.1:9150, Tor
# Browser). Прямого выхода в сеть у скрипта нет и быть не должно: не
# достучались до SOCKS — ошибка, а не подключение мимо Tor.
import os
import select
import socket
import sys

if len(sys.argv) != 4:
    sys.exit('использование: tor-socks.py <логин> <хост> <порт>')
login, host, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
addr = os.environ.get('TOR_SOCKS', '127.0.0.1:9150')
shost, sport = addr.rsplit(':', 1)

s = socket.create_connection((shost, int(sport)))
s.sendall(b'\x05\x01\x02')                    # версия 5, единственный метод — логин/пароль
if s.recv(2) != b'\x05\x02':
    sys.exit('SOCKS: метод с логином не принят')
u, p = login.encode(), b'x'
s.sendall(b'\x01' + bytes([len(u)]) + u + bytes([len(p)]) + p)
if s.recv(2)[1:] != b'\x00':
    sys.exit('SOCKS: логин отвергнут')
h = host.encode()
s.sendall(b'\x05\x01\x00\x03' + bytes([len(h)]) + h + port.to_bytes(2, 'big'))
r = s.recv(4)
if len(r) < 4 or r[1] != 0:
    sys.exit('SOCKS: соединение не удалось, код %r' % (r[1:2],))
atyp = r[3]
if atyp == 1:
    s.recv(4 + 2)
elif atyp == 3:
    n = s.recv(1)[0]
    s.recv(n + 2)
elif atyp == 4:
    s.recv(16 + 2)

# Дальше — прозрачная труба stdin/stdout ↔ сокет, пока одна из сторон не закроется.
s.setblocking(False)
fin, fout = sys.stdin.buffer, sys.stdout.buffer
os.set_blocking(fin.fileno(), False)
while True:
    rl, _, _ = select.select([s, fin], [], [])
    if s in rl:
        d = s.recv(65536)
        if not d:
            break
        fout.write(d)
        fout.flush()
    if fin in rl:
        d = os.read(fin.fileno(), 65536)
        if not d:
            s.shutdown(socket.SHUT_WR)
            break
        s.sendall(d)
