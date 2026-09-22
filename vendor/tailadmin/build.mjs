import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'upstream.json'), 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(dir, 'upstream', file))).digest('hex');
  if (actual !== expected) throw new Error(`Modified upstream source: ${file}`);
}
async function source(file) {
  const $ = load(await fs.readFile(path.join(dir, 'upstream/src', file), 'utf8'), { xml: false }, false);
  // Состояние и подписи подставляет сервер; нативное меню работает без Alpine.
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs)) if (/^(x-|:|@)/.test(name)) $(el).removeAttr(name);
  });
  $.root().find('*').addBack().contents().filter((_, node) => node.type === 'comment').remove();
  return $;
}
const templates = {};
const $sidebar = await source('partials/sidebar.html');
const aside = $sidebar('aside');
aside.addClass('ta ta-sidebar').attr('data-tailadmin-component', 'sidebar');
aside.find('.sidebar-header').addClass('justify-between').html('@@BRAND@@');
const navigation = aside.find('nav');
const group = navigation.children('div').first().clone();
group.find('h3').html('<span class="menu-group-title">Управление магазином</span>');
const list = group.find('ul').first().clone().html('@@NAV@@');
group.children().not('h3').remove();
group.append(list);
navigation.siblings().remove();
navigation.html(group).attr('id', 'a-menu-navigation').attr('aria-label', 'Разделы магазина');
aside.children().slice(2).remove();
templates.sidebar = $sidebar.html(aside);
const $originalSidebar = await source('partials/sidebar.html');
const navItem = $originalSidebar('a.menu-item').first().clone();
navItem.attr('href', '@@HREF@@').attr('class', 'a-nav-item menu-item group @@STATE@@').html('@@ICON@@<span class="menu-item-text">@@LABEL@@</span>@@BADGE@@');
templates.navItem = $originalSidebar.html(navItem);

const $header = await source('partials/header.html');
const header = $header('header').addClass('ta ta-header').attr('data-tailadmin-component', 'header');
const headerInner = header.children('div').first();
const headerRow = headerInner.children('div').first();
const toggle = headerRow.children('button').first().clone();
const toggleSvg = toggle.find('svg').first().clone().attr('class', 'fill-current').attr('aria-hidden', 'true');
templates.toggleIcon = $header.html(toggleSvg);
headerRow.html('@@CONTENT@@').addClass('ta-header-row');
headerInner.children().slice(1).remove();
templates.header = $header.html(header);

const $metric = await source('partials/metric-group/metric-group-01.html');
const metric = $metric.root().children('div').children('div').first();
metric.addClass('ta ta-metric').attr('data-tailadmin-component', 'metric');
metric.children('div').first().html('@@ICON@@');
const values = metric.children('div').eq(1);
values.children('span').remove();
values.find('span').html('@@LABEL@@');
values.find('h4').html('@@VALUE@@');
values.append('<span class="text-xs text-gray-500">@@DETAIL@@</span>');
templates.metric = $metric.html(metric);

// DOM карточки остаётся исходным; внешняя ссылка ведёт в раздел магазина.

const $recent = await source('partials/table/table-01.html');
const recent = $recent.root().children('div').first().addClass('ta ta-recent').attr('data-tailadmin-component', 'recent-orders');
recent.find('h3').text('Последние заказы');
const actions = recent.children('div').first().children('div').last();
const allOrders = actions.find('button').last();
allOrders[0].tagName = 'a';
allOrders.attr('href', '/admin/orders').text('Все заказы →');
actions.children().not(allOrders).remove();
recent.children('div').eq(1).html('@@CONTENT@@');
templates.recentOrders = $recent.html(recent);

const $login = await source('signin.html');
const form = $login('form').first();
const formContainer = form.parent();
formContainer.children().not('form').remove();
form.attr('method', 'post').attr('action', '/admin/login');
const fields = form.children('div').first();
fields.children('div').eq(2).remove();
const username = fields.find('input').eq(0);
username.attr({ type: 'text', id: 'admin-login', name: 'username', autocomplete: 'username', required: '', autofocus: '', placeholder: 'Логин' });
const password = fields.find('input').eq(1);
password.attr({ type: 'password', id: 'admin-password', name: 'password', autocomplete: 'current-password', required: '', placeholder: 'Пароль' });
password.siblings('span').remove();
fields.find('label').eq(0).attr('for', 'admin-login').text('Логин');
fields.find('label').eq(1).attr('for', 'admin-password').text('Пароль');
form.find('button').attr('type', 'submit').text('Войти');
form.prepend('@@ERROR@@');
const login = $login('div').filter((_, el) => ($login(el).attr('class') || '').includes('relative z-1')).first();
login.addClass('ta ta-signin').attr('data-tailadmin-component', 'signin');
login.find('h1').text('Вход в панель');
login.find('h1').next('p').html('@@STORE@@');
const back = login.find('a').first();
back.attr('href', '/');
back.contents().filter((_, el) => el.type === 'text').remove();
back.append('На витрину');
const right = login.find('.bg-brand-950');
right.find('a').replaceWith('<div class="mb-4 text-center text-3xl font-semibold text-white">@@STORE@@</div>');
right.find('p').text('Управление магазином');
const $grid = await source('partials/common-grid-shape.html');
$grid('img').attr('src', '/static/tailadmin-grid.svg').attr('alt', '');
right.find('include').replaceWith($grid.html());
login.find('button').filter((_, el) => !form.find('button').toArray().includes(el)).parent().remove();
templates.signin = $login.html(login);

await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'tailadmin-components.json'), JSON.stringify(templates, null, 2) + '\n');
// Компилируем оригинальный CSS, заменяя удалённый шрифт и список шаблонов.
let input = await fs.readFile(path.join(dir, 'upstream/src/css/style.css'), 'utf8');
input = input.replace(/@import url\([^;]+;/, '').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
input += '\n@source "./components.scan.html";\n' + await fs.readFile(path.join(dir, 'bridge.css'), 'utf8');
await fs.writeFile(path.join(dir, 'components.scan.html'), Object.values(templates).flat().join('\n') + '\nmenu-item-active menu-item-inactive menu-item-icon-active menu-item-icon-inactive');
const compiled = await postcss([tailwind({ base: dir, optimize: { minify: false } })]).process(input, { from: path.join(dir, 'input.css') });
const css = postcss.parse(compiled.css);
css.walkRules(rule => {
  if (rule.parent?.type === 'atrule' && /keyframes$/.test(rule.parent.name)) return;
  if (rule.selector.includes('&')) return;
  let parent = rule.parent, base = false;
  while (parent) { if (parent.type === 'atrule' && parent.name === 'layer' && parent.params === 'base') base = true; parent = parent.parent; }
  rule.selectors = rule.selectors.map(selector => {
    if (/^(?::root|:host|html|body)$/.test(selector.trim())) return 'body.admin';
    if (base) {
      const [, element = '', rest] = selector.match(/^(\*|[-\w]+)?(.*)$/);
      return `${element}:where(.ta, .ta *)${rest}`;
    }
    return `body.admin ${selector}`;
  });
});
css.walkAtRules('layer', rule => { if (rule.nodes) rule.replaceWith(...rule.nodes); else rule.remove(); });
const banner = `TailAdmin ${manifest.version}, MIT, commit ${manifest.commit}. Built from vendor/tailadmin/upstream; see /static/tailadmin.LICENSE.txt`;
const font = '@font-face{font-family:Outfit;font-style:normal;font-weight:100 900;font-display:swap;src:url(/static/fonts/outfit-latin-wght-normal.woff2) format("woff2")}\n';
await fs.writeFile(path.join(output, 'tailadmin.css'), `/*! ${banner} */\n${font}${css.toString()}\n${await fs.readFile(path.join(dir, "integration.css"), "utf8")}`);
await fs.copyFile(path.join(dir, 'upstream/src/images/shape/grid-01.svg'), path.join(output, 'tailadmin-grid.svg'));
await fs.mkdir(path.join(output, 'fonts'), { recursive: true });
await fs.copyFile(path.join(dir, 'node_modules/@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2'), path.join(output, 'fonts/outfit-latin-wght-normal.woff2'));
let license = `TailAdmin ${manifest.version}\n${manifest.repository}\nCommit: ${manifest.commit}\n\n` + await fs.readFile(path.join(dir, 'upstream/LICENSE'), 'utf8');
for (const name of ['tailwindcss', '@tailwindcss/forms', '@fontsource-variable/outfit']) {
 const folder = path.join(dir, 'node_modules', name);
 const filename = (await fs.readdir(folder)).find(f => /^licen[sc]e(?:\.|$)/i.test(f));
 license += `\n\n${name}\n${await fs.readFile(path.join(folder, filename), 'utf8')}`;
}
await fs.writeFile(path.join(output, 'tailadmin.LICENSE.txt'), license);
console.log(`TailAdmin ${manifest.version}: original components and CSS built (${manifest.commit}).`);
