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
#
# Оба конца НЕблокирующие, и данные пишутся через send()/os.write() с ДОБОРОМ по
# select на запись, а не через sendall(). Прежний `s.sendall(d)` по неблокирующему
# сокету на заливке (буфер отправки Tor переполнен) кидал EAGAIN и ронял прокси:
# отдача (мало байт в сокет) это скрывала, а push на onion рвался постоянно —
# части доезжали по мегабайту за часы. Обратное давление через буферы не даёт им
# расти без предела: пока не разгрузили сторону, с неё не читаем.
s.setblocking(False)
fin, fout = sys.stdin.buffer, sys.stdout.buffer
in_fd, out_fd = fin.fileno(), fout.fileno()
os.set_blocking(in_fd, False)
os.set_blocking(out_fd, False)

BUF = 1 << 20            # порог обратного давления на каждую сторону
to_sock = b''           # прочитано из stdin, ждёт записи в сокет
to_out = b''            # прочитано из сокета, ждёт записи в stdout
in_eof = False          # stdin закрылся
wr_shut = False         # half-close сокета на запись уже сделан
sock_eof = False        # сокет закрылся на чтение

while True:
    rset, wset = [], []
    if not in_eof and len(to_sock) < BUF:
        rset.append(in_fd)
    if not sock_eof and len(to_out) < BUF:
        rset.append(s)
    if to_sock:
        wset.append(s)
    if to_out:
        wset.append(out_fd)
    if not rset and not wset:
        break
    rl, wl, _ = select.select(rset, wset, [])

    if in_fd in rl:
        d = os.read(in_fd, 65536)
        if d:
            to_sock += d
        else:
            in_eof = True
    if s in rl:
        try:
            d = s.recv(65536)
        except (BlockingIOError, InterruptedError):
            d = None
        if d == b'':
            sock_eof = True
        elif d:
            to_out += d

    if s in wl and to_sock:
        try:
            to_sock = to_sock[s.send(to_sock):]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            break
    if out_fd in wl and to_out:
        try:
            to_out = to_out[os.write(out_fd, to_out):]
        except (BlockingIOError, InterruptedError):
            pass
        except OSError:
            break

    if in_eof and not to_sock and not wr_shut:
        try:
            s.shutdown(socket.SHUT_WR)
        except OSError:
            pass
        wr_shut = True
    if sock_eof and not to_out:
        break
