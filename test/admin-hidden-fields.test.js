'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const minify = require('../lib/minify');

// Небольшой DOM для настоящего morph(): важны отражение hidden.value в
// атрибут, стабильность узлов форм и отдельно набранные человеком значения.
class Element {
  constructor(tag, attributes = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attributes));
    this.children = [];
    this.parentNode = null;
    this.value = attributes.value || '';
    this.checked = Object.hasOwn(attributes, 'checked');
    this.selected = Object.hasOwn(attributes, 'selected');
    this.classList = { contains: name => (this.getAttribute('class') || '').split(/\s+/).includes(name) };
    for (const child of children) this.insertBefore(child, null);
  }
  get type() { return (this.getAttribute('type') || 'text').toLowerCase(); }
  get id() { return this.getAttribute('id') || ''; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  hasAttribute(name) { return this.attrs.has(name); }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'value' && this.tagName === 'INPUT' && this.type === 'hidden') this.value = String(value);
  }
  removeAttribute(name) {
    this.attrs.delete(name);
    if (name === 'value' && this.tagName === 'INPUT' && this.type === 'hidden') this.value = '';
  }
  insertBefore(child, before) {
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.ok(index >= 0);
    this.children.splice(index, 1);
    child.parentNode = null;
  }
  cloneNode() {
    return new Element(this.tagName, Object.fromEntries(this.attrs), this.children.map(child => child.cloneNode()));
  }
}

function liveMorph() {
  const source = fs.readFileSync(path.join(__dirname, '../public/admin-live.js'), 'utf8');
  const begin = source.indexOf('  function keyOf(');
  const end = source.indexOf('  function blocked(');
  assert.ok(begin >= 0 && end > begin, 'исполняется существующий блок переноса DOM');
  const context = { document: { importNode: node => node.cloneNode(true) } };
  vm.runInNewContext(minify.js(source.slice(begin, end)) + '\nthis.runMorph = morph; this.owns = ownedByUser;', context);
  return { morph: context.runMorph, owns: context.owns };
}

function filterForm(id, method, period, pay) {
  return new Element('form', { id, method }, [
    new Element('input', { type: 'hidden', name: 'period', value: period }),
    new Element('input', { type: 'hidden', name: 'pay', value: pay })
  ]);
}
function formValues(form) {
  return Object.fromEntries(form.children.map(field => [field.getAttribute('name'), field.value]));
}

test('Ajax смена периода и статуса обновляет контекст GET поиска и POST возврата, сохраняя узлы форм', () => {
  const { morph } = liveMorph();
  const search = filterForm('order-search', 'get', 'today', 'all');
  const action = filterForm('mark-paid', 'post', 'today', 'all');
  const page = new Element('section', {}, [search, action]);
  const periodField = action.firstChild;
  morph(page, new Element('section', {}, [
    filterForm('order-search', 'get', 'month', 'paid'),
    filterForm('mark-paid', 'post', 'month', 'paid')
  ]));
  assert.equal(page.firstChild, search);
  assert.equal(search.nextSibling, action);
  assert.equal(action.firstChild, periodField);
  assert.deepEqual(formValues(search), { period: 'month', pay: 'paid' });
  assert.deepEqual(formValues(action), { period: 'month', pay: 'paid' });
  // Следующий переход к полному списку тоже не оставляет прежний фильтр.
  morph(action, filterForm('mark-paid', 'post', 'all', 'all'));
  assert.deepEqual(formValues(action), { period: 'all', pay: 'all' });
});

test('очистка и удаление серверного value у hidden не сохраняют устаревший параметр', () => {
  const { morph, owns } = liveMorph();
  const hidden = new Element('input', { type: 'HIDDEN', name: 'return', value: '/old' });
  assert.equal(owns(hidden, 'value'), false);
  morph(hidden, new Element('input', { type: 'hidden', name: 'return', value: '' }));
  assert.equal(hidden.value, '');
  assert.equal(hidden.getAttribute('value'), '');
  hidden.setAttribute('value', '/stale');
  morph(hidden, new Element('input', { type: 'hidden', name: 'return' }));
  assert.equal(hidden.value, '');
  assert.equal(hidden.hasAttribute('value'), false);
});

test('morph сохраняет введённый текст, checkbox, select и открытые details рядом с обновляемым hidden', () => {
  const { morph, owns } = liveMorph();
  const text = new Element('input', { id: 'search', value: 'исходный запрос' });
  text.value = 'недописанный запрос';
  const checkbox = new Element('input', { id: 'editing', type: 'checkbox' });
  checkbox.checked = true;
  const textarea = new Element('textarea', { id: 'answer' });
  textarea.value = 'Черновик ответа';
  const option = new Element('option', { value: 'mine', selected: '' });
  const select = new Element('select', { id: 'choice' }, [option]);
  select.value = 'mine';
  const details = new Element('details', { id: 'details', open: '' });
  const hidden = new Element('input', { id: 'period', type: 'hidden', value: 'week' });
  const page = new Element('section', {}, [text, checkbox, textarea, select, details, hidden]);
  morph(page, new Element('section', {}, [
    new Element('input', { id: 'search', value: 'серверный запрос' }),
    new Element('input', { id: 'editing', type: 'checkbox' }),
    new Element('textarea', { id: 'answer' }),
    new Element('select', { id: 'choice' }, [new Element('option', { value: 'server', selected: '' })]),
    new Element('details', { id: 'details' }),
    new Element('input', { id: 'period', type: 'hidden', value: 'month' })
  ]));
  assert.equal(text.value, 'недописанный запрос');
  assert.equal(text.getAttribute('value'), 'исходный запрос');
  assert.equal(checkbox.checked, true);
  assert.equal(textarea.value, 'Черновик ответа');
  assert.equal(select.value, 'mine');
  assert.equal(select.firstChild, option);
  assert.equal(option.selected, true);
  assert.equal(details.hasAttribute('open'), true);
  assert.equal(hidden.value, 'month');
  for (const [element, attribute] of [[text, 'value'], [checkbox, 'checked'], [textarea, 'value'], [select, 'value'], [option, 'selected'], [details, 'open']]) {
    assert.equal(owns(element, attribute), true);
  }
});
