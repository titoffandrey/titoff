'use strict';
// Способы доставки. Список закрытый и один на всех: по нему рисуется выбор на
// оформлении, проверяется заказ на сервере и подписывается строка в панелях.
// Отдельный модуль, а не константа в render.js, потому что список нужен и в
// lib/db.js при нормализации заказа — а db.js рендер не подключает и не должен
// (render -> tenancy -> db, вышел бы цикл).
//
// id пишется в заказ и остаётся в старых заявках навсегда, поэтому менять их
// нельзя — только добавлять новые. Название можно править свободно.
const METHODS = [
  { id: 'cdek', name: 'СДЭК', hint: 'Курьером до двери или в пункт выдачи' },
  { id: 'ozon', name: 'OZON', hint: 'В пункт выдачи или постамат OZON' }
];

function find(id) {
  const key = String(id == null ? '' : id);
  return METHODS.find(m => m.id === key) || null;
}
function isValid(id) { return !!find(id); }
// Название для панелей и Telegram. Неизвестный id (или заказ без доставки —
// такими остались все прежние заявки) даёт пустую строку, а не «undefined».
function nameOf(id) { const m = find(id); return m ? m.name : ''; }

module.exports = { METHODS, find, isValid, nameOf };
