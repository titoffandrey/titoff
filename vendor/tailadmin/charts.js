import ApexCharts from 'apexcharts';
import barOptions from './chart-options-01.js';
import radialOptions from './chart-options-02.js';
import areaOptions from './chart-options-03.js';
import jsVectorMap from 'jsvectormap';
import 'jsvectormap/dist/maps/world.js';
import mapOptions from './map-options.js';

// Используем исходные настройки TailAdmin; заменяем только данные и русские подписи.
const factories = { bar: barOptions, radialBar: radialOptions, area: areaOptions };
const instances = new Map();
const maps = new Map();
const number = value => Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
function optionsFor(el, data) {
  const dark = document.documentElement.classList.contains('dark');
  const options = factories[el.dataset.taChart]();
  options.series = data.series;
  options.chart.fontFamily = 'Outfit, Roboto, sans-serif';
  options.chart.foreColor = dark ? '#98a2b3' : '#667085';
  options.chart.animations = { enabled: !matchMedia('(prefers-reduced-motion: reduce)').matches };
  options.chart.background = 'transparent';
  options.theme = { mode: dark ? 'dark' : 'light' };
  const format = value => number(value) + (data.currency ? ' ₽' : '');
  if (el.dataset.taChart === 'radialBar') {
    options.labels = ['Оплачено'];
    options.plotOptions.radialBar.track.background = dark ? '#344054' : '#e4e7ec';
    options.plotOptions.radialBar.dataLabels.value.color = dark ? '#f2f4f7' : '#1d2939';
    options.plotOptions.radialBar.dataLabels.value.formatter = value => number(value) + '%';
  } else {
    options.xaxis.categories = data.labels;
    options.xaxis.labels = { ...options.xaxis.labels, hideOverlappingLabels: true, trim: true };
    options.yaxis = { ...options.yaxis, labels: { formatter: format }, min: 0 };
    options.grid.borderColor = dark ? '#1d2939' : '#f2f4f7';
    options.tooltip = { ...options.tooltip, theme: dark ? 'dark' : 'light', y: { formatter: format } };
    options.noData = { text: 'Пока нет данных', style: { color: dark ? '#98a2b3' : '#667085' } };
  }
  return options;
}
async function refresh() {
  for (const [el, state] of maps) {
    if (!el.isConnected) { state.map.destroy(); maps.delete(el); }
  }
  for (const el of document.querySelectorAll('[data-ta-map]')) {
    const raw = el.dataset.taConfig;
    const dark = document.documentElement.classList.contains('dark');
    const previous = maps.get(el);
    if (previous && previous.raw === raw && previous.dark === dark) continue;
    if (previous) { previous.map.destroy(); maps.delete(el); }
    el.querySelector('[data-ta-map-canvas]').replaceChildren();
    try {
      const countries = JSON.parse(raw);
      const options = mapOptions();
      options.selector = el.querySelector('[data-ta-map-canvas]');
      options.markers = [];
      options.regionStyle.initial.fill = dark ? '#344054' : '#D9D9D9';
      options.regionStyle.selected = { fill: '#465fff' };
      options.selectedRegions = countries.map(c => c.code).filter(Boolean);
      options.onRegionTooltipShow = (tooltip, code) => {
        const country = countries.find(c => c.code === code);
        if (country) tooltip.text(country.name + ': ' + number(country.value));
      };
      const map = new jsVectorMap(options);
      maps.set(el, { map, raw, dark });
    } catch (error) { console.error('Не удалось показать карту', error); }
  }
  for (const [el, state] of instances) {
    if (!el.isConnected) { state.chart.destroy(); instances.delete(el); }
  }
  for (const el of document.querySelectorAll('[data-ta-chart]')) {
    try {
      const raw = el.dataset.taConfig;
      const mode = document.documentElement.classList.contains('dark');
      let state = instances.get(el);
      if (state && state.raw === raw && state.mode === mode) { el.classList.add('ta-chart-ready'); continue; }
      const data = JSON.parse(raw);
      const options = optionsFor(el, data);
      if (!state) {
        const chart = new ApexCharts(el.querySelector('[data-ta-chart-canvas]'), options);
        state = { chart, raw, mode };
        instances.set(el, state);
        await chart.render();
      } else {
        state.raw = raw; state.mode = mode;
        await state.chart.updateOptions(options, false, false);
      }
      if (el.isConnected) el.classList.add('ta-chart-ready');
    } catch (error) {
      // Читаемая серверная таблица остаётся доступной при ошибке графической библиотеки.
      const state = instances.get(el);
      if (state) { try { state.chart.destroy(); } catch (_) {} instances.delete(el); }
      el.classList.remove('ta-chart-ready');
      console.error('Не удалось показать диаграмму', error);
    }
  }
}
let pending = Promise.resolve();
function schedule() { pending = pending.then(refresh); }
document.addEventListener('admin-live:updated', schedule);
document.addEventListener('tailadmin:theme', schedule);
schedule();
