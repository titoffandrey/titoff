/* Управление оригинальными компонентами TailAdmin без демонстрационного Alpine-приложения. */
(function () {
  'use strict';
  var root = document.documentElement;
  function syncTheme() {
    var dark = root.classList.contains('dark');
    document.querySelectorAll('[data-ta-theme]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(dark));
      if (button.getAttribute('role') === 'switch') button.setAttribute('aria-checked', String(dark));
      button.setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
      button.title = dark ? 'Светлая тема' : 'Тёмная тема';
    });
  }
  function collapse() {
    var collapsed = root.classList.toggle('ta-collapsed');
    try { localStorage.setItem('tailadminSidebar', String(collapsed)); } catch (_) {}
    document.querySelectorAll('.a-menu-btn').forEach(function (button) {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', collapsed ? 'Развернуть меню' : 'Свернуть меню');
    });
  }
  document.addEventListener('click', function (event) {
    document.querySelectorAll('.ta-profile[open],.ta-notifications[open]').forEach(function (menu) { if (!menu.contains(event.target)) menu.open = false; });
    var theme = event.target.closest('[data-ta-theme]');
    if (theme) {
      root.classList.toggle('dark');
      try { localStorage.setItem('darkMode', JSON.stringify(root.classList.contains('dark'))); } catch (_) {}
      syncTheme();
      document.dispatchEvent(new CustomEvent('tailadmin:theme'));
    }
    if (event.target.closest('[data-ta-search-focus]')) {
      var input = document.getElementById('search-input'); if (input) input.focus();
    }
    var toggle = event.target.closest('.a-menu-btn');
    if (toggle && matchMedia('(min-width:1280px)').matches) { event.preventDefault(); event.stopImmediatePropagation(); collapse(); }
    var open = event.target.closest('[data-ta-dialog]');
    if (open) {
      var dialog = document.getElementById(open.dataset.taDialog);
      if (dialog) { dialog.showModal(); dialog.dataset.taOpener = open.id || ''; }
    }
    var close = event.target.closest('[data-ta-close]');
    if (close) close.closest('dialog').close();
    if (event.target.tagName === 'DIALOG') {
      var box = event.target.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close();
    }
  }, true);
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') document.querySelectorAll('.ta-profile[open],.ta-notifications[open]').forEach(function (menu) { menu.open = false; menu.querySelector('summary').focus(); });
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      var input = document.getElementById('search-input'); if (input) { event.preventDefault(); input.focus(); }
    }
    if (event.target.matches('.a-menu-btn') && matchMedia('(min-width:1280px)').matches && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopImmediatePropagation(); collapse();
    }
  }, true);
  var openedHash = '';
  function refresh() {
    syncTheme();
    if (location.hash.indexOf('#order-') === 0 && openedHash !== location.hash) {
      var row = document.getElementById(location.hash.slice(1));
      var dialog = row && row.querySelector('dialog');
      if (dialog && !dialog.open) { dialog.showModal(); openedHash = location.hash; }
    }
  }
  document.addEventListener('admin-live:updated', refresh);
  window.addEventListener('hashchange', function () { openedHash = ''; refresh(); });
  window.addEventListener('storage', function (event) {
    if (event.key !== 'darkMode') return;
    root.classList.toggle('dark', event.newValue === 'true');
    syncTheme(); document.dispatchEvent(new CustomEvent('tailadmin:theme'));
  });
  refresh();
})();
