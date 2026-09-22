'use strict';
// Шаблоны собраны из закреплённых оригинальных исходников TailAdmin (MIT).
// Значения — доверенная разметка или экранированные вызывающим кодом строки.
// Подстановка однопроходная: текст магазина не может стать новым шаблоном.
const components = require('../public/tailadmin-components.json');
function render(name, slots) {
  return components[name].replace(/@@([A-Z]+)@@/g, (_, key) => {
    if (!Object.hasOwn(slots, key)) throw new Error(`TailAdmin ${name}: missing ${key}`);
    return String(slots[key]);
  });
}
function navItem(href, label, icon, badge, active, external) {
  let html = render('navItem', { HREF: href, LABEL: label, ICON: icon, BADGE: badge,
    STATE: active ? 'active menu-item-active' : 'menu-item-inactive' });
  if (active) html = html.replace('href="' + href + '"', 'href="' + href + '" aria-current="page"');
  if (external) html = html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
  return `<li>${html}</li>`;
}
module.exports = { render, navItem, toggleIcon: components.toggleIcon };
