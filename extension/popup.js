// SPDX-License-Identifier: GPL-3.0-only
import { normalizeHosts } from './core.js';

const $ = selector => document.querySelector(selector);
let settings;
async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '后台未响应，请重新打开扩展。');
  return response.data;
}
function status(text, error = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('error', error);
}
function action(button, task) {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await task(); } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  });
}
function updateMode() {
  $('#enabled').checked = settings.enabled;
  $('#enabled').disabled = false;
  $('#mode').textContent = settings.enabled ? '已开启 · 重复打开自动返回' : '已暂停 · 可以自由打开重复页';
}
function tabRow(tab, label, task) {
  const row = document.createElement('div');
  row.className = 'tab-row';
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = tab.title || tab.url;
  title.title = tab.url;
  const button = document.createElement('button');
  button.textContent = label;
  button.type = 'button';
  button.disabled = !task;
  if (task) action(button, task);
  row.append(title, button);
  return row;
}
async function refresh(loadSettings = false) {
  const data = await send('snapshot');
  settings = data.settings;
  updateMode();
  if (loadSettings) $('#excluded').value = settings.excludedHosts.join('\n');
  const container = $('#duplicates');
  container.replaceChildren();
  if (!data.groups.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '没有需要处理的重复页';
    container.append(empty);
  }
  for (const { keep, duplicates } of data.groups) {
    const group = document.createElement('div');
    group.className = 'group';
    const label = document.createElement('p');
    label.className = 'keep-label';
    label.textContent = '保留这一页';
    group.append(label, tabRow(keep, '前往', () => send('focus', { id: keep.id })));
    for (const tab of duplicates) {
      group.append(tabRow(tab, tab.closable ? '关闭重复页' : '已保护', tab.closable ? async () => {
        if (!confirm('确认关闭这张重复页？请先保存该页面未提交的内容。')) return;
        const closed = await send('close', { id: tab.id, keepId: keep.id, url: tab.url });
        status(closed ? '已关闭重复页。' : '页面状态已变化，未关闭，请重新查看。');
        await refresh();
      } : null));
    }
    container.append(group);
  }
}
$('#enabled').addEventListener('change', async () => {
  $('#enabled').disabled = true;
  try {
    settings = await send('settings', { value: { ...settings, enabled: $('#enabled').checked } });
    status(settings.enabled ? '已恢复，从下一次新建标签或地址栏导航开始处理。' : '自动去重已暂停。');
  } catch (error) { status(error.message, true); }
  finally { updateMode(); }
});
action($('#save'), async () => {
  const excludedHosts = normalizeHosts($('#excluded').value);
  settings = await send('settings', { value: { ...settings, excludedHosts } });
  $('#excluded').value = settings.excludedHosts.join('\n');
  status('已保存网站排除名单。');
  await refresh();
});
action($('#exclude-current'), async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.match(/^https?:\/\//)) throw new Error('请先切到需要排除的网站。');
  const host = new URL(tab.url).hostname;
  $('#excluded').value = normalizeHosts(`${$('#excluded').value}\n${host}`).join('\n');
  status('已加入输入框，点击“保存”后生效。');
});
action($('#refresh'), () => refresh());
refresh(true).catch(error => status(error.message, true));
