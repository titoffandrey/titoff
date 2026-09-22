import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { build } from 'esbuild';

const dir = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(process.argv[2]);
const manifest = JSON.parse(await fs.readFile(path.join(dir, 'upstream.json'), 'utf8'));
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await fs.readFile(path.join(dir, 'upstream', file))).digest('hex');
  if (actual !== expected) throw new Error(`Modified upstream source: ${file}`);
}
async function source(file, bindings = false) {
  const $ = load(await fs.readFile(path.join(dir, 'upstream/src', file), 'utf8'), { xml: false }, false);
  // Состояние и подписи подставляет сервер; нативное меню работает без Alpine.
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs)) if (!bindings && /^(x-|:|@)/.test(name)) $(el).removeAttr(name);
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
const $rawHeader = await source('partials/header.html', true);
const theme = $rawHeader('button').filter((_, el) => String(el.attribs['@click.prevent'] || '').includes('darkMode')).first();
for (const attr of Object.keys(theme[0].attribs)) if (/^(x-|:|@)/.test(attr)) theme.removeAttr(attr);
theme.attr({ type: 'button', 'data-ta-theme': '', 'aria-label': 'Включить тёмную тему', 'aria-pressed': 'false' });
templates.themeToggle = $rawHeader.html(theme);
const search = headerRow.find('form').first().clone().attr({ action: '/admin/orders', method: 'get', class: 'ta-header-search' });
search.find('input').attr({ name: 'q', type: 'search', placeholder: 'Поиск заказа…', 'aria-label': 'Поиск заказов', autocomplete: 'off' });
search.find('button').attr({ type: 'button', 'data-ta-search-focus': '', 'aria-label': 'Перейти к поиску' });
templates.headerSearch = $header.html(search);
// Панель справа сохраняет оригинальную раскладку шапки, значения подставляет магазин.
headerRow.html('@@CONTENT@@').addClass('ta-header-row');
headerInner.children('div').eq(1).html('@@ACTIONS@@').addClass('ta-header-actions');
templates.header = $header.html(header);

const $profile = await source('partials/header.html');
const profile = $profile('header > div > div').eq(1).children('div').last().clone();
profile[0].tagName = 'details';
profile.addClass('ta-profile');
const profileButton = profile.children('a').first();
profileButton[0].tagName = 'summary';
profileButton.removeAttr('href').attr('aria-label', 'Меню профиля');
profileButton.children('span').first().addClass('ta-profile-avatar').html('@@INITIAL@@');
profileButton.children('span').eq(1).text('@@NAME@@');
const profileMenu = profile.children('div').last().addClass('ta-profile-menu');
const profileLink = profileMenu.find('a').first().clone().attr('href', '/admin/settings').text('Настройки');
profileMenu.html('<p class="text-sm text-gray-500 dark:text-gray-400">@@NAME@@</p>');
profileMenu.append(profileLink);
templates.profileMenu = $profile.html(profile);

const $notifications = await source('partials/header.html');
const notifications = $notifications('header > div > div').eq(1).find('div').filter((_, el) => $notifications(el).hasClass('relative') && $notifications(el).children('button').length && $notifications(el).find('ul').length).first().clone();
notifications[0].tagName = 'details';
notifications.addClass('ta-notifications');
const bell = notifications.children('button').first();
bell[0].tagName = 'summary';
bell.attr('aria-label', 'Уведомления магазина');
bell.children('span').remove();
bell.append('<span class="ta-notification-count">@@COUNT@@</span>');
const notificationMenu = notifications.children('div').last().addClass('ta-notifications-menu');
notificationMenu.html('@@ITEMS@@');
templates.notificationMenu = $notifications.html(notifications);

const $frame = await source('partials/table/table-06.html');
const frame = $frame.root().children('div').first().addClass('ta ta-table-frame');
frame.find('table').replaceWith('@@TABLE@@');
templates.tableFrame = $frame.html(frame);
const $bread = await source('partials/breadcrumb.html');
const breadcrumb = $bread.root().children().first().addClass('ta ta-page-heading');
breadcrumb.find('h2').text('@@TITLE@@');
breadcrumb.find('h2')[0].tagName = 'h1';
breadcrumb.find('nav').html('@@ACTIONS@@');
templates.breadcrumb = $bread.html(breadcrumb);

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
recent.find('h3').text('@@TITLE@@');
const actions = recent.children('div').first().children('div').last();
const allOrders = actions.find('button').last();
allOrders[0].tagName = 'a';
allOrders.attr('href', '/admin/orders').text('Все заказы →');
actions.children().not(allOrders).remove();
const table = recent.find('table');
table.addClass('ta-orders-table');
table.find('thead th').each((i, el) => $recent(el).find('p').text(['Товар / заказ', 'Покупатель', 'Сумма', 'Статус'][i]));
table.find('tbody').html('@@ROWS@@');
templates.recentOrders = $recent.html(recent);
const $tableSource = await source('partials/table/table-01.html');
const row = $tableSource('tbody tr').first().clone();
row.attr({id: '@@ID@@', 'data-live-key': '@@ID@@'});
row.children('td').each((i, el) => $tableSource(el).html(['@@PRODUCT@@', '@@CUSTOMER@@', '@@TOTAL@@', '@@STATUS@@'][i]));
templates.orderRow = $tableSource.html(row);
const ordersTable = table.clone();
ordersTable.find('thead tr').append('<th class="px-6 py-3 text-theme-xs font-medium text-gray-500 dark:text-gray-400">Действия</th>');
templates.ordersTable = '<div class="ta custom-scrollbar max-w-full overflow-x-auto">' + $recent.html(ordersTable) + '</div>';
const fullRow = row.clone().attr('class', '@@ROWCLASS@@');
fullRow.append('<td class="px-6 py-3 text-sm">@@ACTIONS@@</td>');
templates.orderFullRow = $tableSource.html(fullRow);

const $map = await source('partials/map-01.html');
const map = $map.root().children('div').first().addClass('ta ta-map-card').attr('data-tailadmin-component', 'map-01');
map.find('.relative.h-fit').remove();
map.find('h3').text('Посетители по странам');
map.find('h3').next('p').text('География посещений сегодня');
map.find('#mapOne').attr({ id: 'visitors-map', 'data-ta-map': '', 'data-ta-config': '@@DATA@@', 'data-live-key': 'visitors-map', 'aria-label': 'Карта стран посетителей' }).html('<div data-ta-map-canvas="" data-live-key="visitors-map-canvas"></div>');
const countryRow = map.find('.space-y-5').children('div').first().clone();
countryRow.find('img').replaceWith('<span class="ta-country-flag" aria-hidden="true">@@FLAG@@</span>');
countryRow.find('p').eq(0).text('@@NAME@@');
countryRow.find('span').last().text('@@COUNT@@');
countryRow.find('p').eq(1).text('@@PERCENT@@%');
countryRow.find('.bg-brand-500').removeClass('w-[79%]').attr('style', 'width:@@PERCENT@@%');
templates.countryRow = $map.html(countryRow);
map.find('.space-y-5').html('@@COUNTRIES@@');
templates.map = $map.html(map);
// Исходные настройки карты сохраняются; демонстрационные точки заменяет адаптер.
const mapCode = await fs.readFile(path.join(dir, 'upstream/src/js/components/map-01.js'), 'utf8');
const mapOptions = mapCode.slice(mapCode.indexOf('new jsVectorMap(') + 'new jsVectorMap('.length, mapCode.lastIndexOf(');'));
await fs.writeFile(path.join(dir, 'map-options.js'), `export default function () { return ${mapOptions}; }\n`);

for (const [number, name, type] of [['01','barChart','bar'], ['02','radialChart','radialBar'], ['03','areaChart','area']]) {
  const $ = await source(`partials/chart/chart-${number}.html`);
  const card = $.root().children('div').first().addClass('ta ta-chart-card').attr('data-tailadmin-component', `chart-${number}`);
  card.find('.relative.h-fit').remove();
  card.find('h3').text('@@TITLE@@');
  const chart = card.find('[id^="chart"]');
  chart.attr({ id: '@@ID@@', 'data-ta-chart': type, 'data-ta-config': '@@DATA@@', 'data-live-key': '@@ID@@' });
  chart.html('<div class="ta-chart-canvas" data-ta-chart-canvas="" data-live-key="@@ID@@-canvas"></div><div class="ta-chart-fallback">@@FALLBACK@@</div>');
  if (number === '01') card.children('div').first().append('@@CONTROLS@@');
  if (number === '02') {
    card.find('h3').next('p').text('@@SUBTITLE@@');
    chart.siblings('span').remove();
    card.children('div').first().children('p').text('@@DESCRIPTION@@');
    const facts = card.children('div').eq(1).children('div').filter((_, el) => $(el).find('p').length > 0);
    facts.each((i, el) => { $(el).find('p').eq(0).text(['Заказов','Оплачено','Выручка'][i]); $(el).find('p').eq(1).html(['@@COUNT@@','@@PAID@@','@@REVENUE@@'][i]); });
  }
  if (number === '03') {
    card.find('h3').next('p').text('@@SUBTITLE@@');
    card.children('div').first().children('div').last().html('@@CONTROLS@@');
  }
  templates[name] = $.html(card);
  const code = await fs.readFile(path.join(dir, `upstream/src/js/components/charts/chart-${number}.js`), 'utf8');
  const options = code.slice(code.indexOf('  const chart'), code.indexOf('  const chartSelector'));
  const variable = options.match(/const (\w+) =/)[1];
  await fs.writeFile(path.join(dir, `chart-options-${number}.js`), `// Настройки оригинальной диаграммы TailAdmin.\nexport default function () {\n${options}\nreturn ${variable};\n}\n`);
}
const $dashboard = await source('index.html');
const grid = $dashboard('main > div > div').first().addClass('ta ta-dashboard-grid');
grid.children('div').each((i, el) => $dashboard(el).html(['@@METRICS@@@@BAR@@','@@RADIAL@@','@@AREA@@','@@ACTIVITY@@','@@RECENT@@'][i]));
templates.dashboard = $dashboard.html(grid);
const $modal = await source('partials/profile/profile-info-modal.html');
const modal = $modal('[class]').filter((_, el) => String(el.attribs.class).includes('max-w-')).first();
templates.dialogClass = modal.attr('class') || 'relative w-full max-w-175 rounded-3xl bg-white p-6 dark:bg-gray-900';

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
login.find('button').filter((_, el) => !form.find('button').toArray().includes(el)).parent().html(templates.themeToggle);
templates.signin = $login.html(login);

await fs.mkdir(output, { recursive: true });
await fs.writeFile(path.join(output, 'tailadmin-components.json'), JSON.stringify(templates, null, 2) + '\n');
// Компилируем оригинальный CSS, заменяя удалённый шрифт и список шаблонов.
let input = await fs.readFile(path.join(dir, 'upstream/src/css/style.css'), 'utf8');
input = input.replace(/@import url\([^;]+;/, '').replace('@import "tailwindcss";', '@import "tailwindcss" source(none);');
input = input.replaceAll('#chartOne', '[data-ta-chart="bar"]').replaceAll('#chartTwo', '[data-ta-chart="radialBar"]').replaceAll('#chartThree', '[data-ta-chart="area"]');
input += '\n@source "./components.scan.html";\n' + await fs.readFile(path.join(dir, 'bridge.css'), 'utf8');
input += '\n' + await fs.readFile(path.join(dir, 'node_modules/jsvectormap/dist/jsvectormap.css'), 'utf8');
await fs.writeFile(path.join(dir, 'components.scan.html'), Object.values(templates).flat().join('\n') + '\nmenu-item-active menu-item-inactive menu-item-icon-active menu-item-icon-inactive ' + await fs.readFile(path.join(dir, 'classes.html'), 'utf8'));
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
for (const name of ['tailwindcss', '@tailwindcss/forms', '@fontsource-variable/outfit', 'apexcharts', 'jsvectormap']) {
 const folder = path.join(dir, 'node_modules', name);
 const filename = (await fs.readdir(folder)).find(f => /^licen[sc]e(?:\.|$)/i.test(f));
 license += `\n\n${name}\n${await fs.readFile(path.join(folder, filename), 'utf8')}`;
}
await build({ entryPoints: [path.join(dir, 'charts.js')], outfile: path.join(output, 'tailadmin-charts.js'), bundle: true, minify: true, format: 'iife', target: 'es2020', legalComments: 'none', banner: { js: `/*! ${banner} */` } });
await fs.copyFile(path.join(dir, 'ui.js'), path.join(output, 'tailadmin-ui.js'));
await fs.writeFile(path.join(output, 'tailadmin.LICENSE.txt'), license);
console.log(`TailAdmin ${manifest.version}: original components and CSS built (${manifest.commit}).`);
