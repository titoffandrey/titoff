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
  html = html.replace('<a ', '<a aria-label="' + label + '" ');
  if (active) html = html.replace('href="' + href + '"', 'href="' + href + '" aria-current="page"');
  if (external) html = html.replace('<a ', '<a target="_blank" rel="noopener noreferrer" ');
  return `<li>${html}</li>`;
}
module.exports = { render, navItem, toggleIcon: components.toggleIcon };

const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function chart(name, id, data, slots) {
  const labels = data.labels || ['Оплачено'];
  const series = data.series || [];
  const fallback = `<table class="ta-chart-data"><caption>${esc(slots.TITLE)}</caption><tbody>${labels.map((label, i) => `<tr><th>${esc(label)}</th>${series.map(s => `<td>${esc(typeof s === 'number' ? s + '%' : s.data[i] == null ? '—' : s.data[i])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return render(name, { ...slots, ID: esc(id), DATA: esc(JSON.stringify(data)), FALLBACK: fallback });
}
module.exports.chart = chart;
module.exports.themeBoot = `<script>try{document.documentElement.classList.toggle('dark',localStorage.getItem('darkMode')==='true');document.documentElement.classList.toggle('ta-collapsed',localStorage.getItem('tailadminSidebar')==='true')}catch(e){}</script>`;
module.exports.themeToggle = components.themeToggle;
module.exports.dialogClass = components.dialogClass;
