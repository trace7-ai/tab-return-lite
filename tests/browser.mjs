import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const server = createServer((request, response) => {
  if (request.url.startsWith('/redirect')) {
    response.writeHead(302, { Location: '/report?id=1#sql' });
    response.end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>示例报表</title><h1>示例报表</h1><label>未提交的 SQL <input id="draft"></label></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const url = `${base}/report?id=1#sql`;
const profile = await mkdtemp(path.join(tmpdir(), 'tab-return-test-'));
let context;
let worker;
let apiPage;
const errors = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(task, label, timeout = 12_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await task()) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}`);
}
const api = (fn, arg) => (apiPage || worker).evaluate(fn, arg);
const getTabs = () => api(() => chrome.tabs.query({}));
async function settled(id) {
  await until(async () => api(async id => {
    const { pending = {} } = await chrome.storage.session.get('pending');
    const tabs = await chrome.tabs.query({});
    return !pending[id] && tabs.some(tab => tab.id === id && tab.status === 'complete');
  }, id), `标签 ${id} 加载完毕`);
}
async function closed(id) {
  await until(async () => !(await getTabs()).some(tab => tab.id === id), `标签 ${id} 自动关闭`);
}

try {
  const extension = path.resolve('extension');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.HEADED !== '1',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  context.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  context.on('weberror', error => errors.push(error.error().message));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await api(() => {
    globalThis.navigationTrace = [];
    chrome.webNavigation.onCommitted.addListener(details => navigationTrace.push(details));
    globalThis.focusTrace = [];
    const update = chrome.windows.update.bind(chrome.windows);
    chrome.windows.update = async (...args) => {
      const result = await update(...args);
      focusTrace.push({ args, result });
      return result;
    };
  });
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#enabled:enabled').waitFor();
  assert.equal(await popup.title(), '回到已打开');

  const old = await api(url => chrome.tabs.create({ url }), url);
  await settled(old.id);
  const originalPage = context.pages().find(page => page.url() === url);
  assert.ok(originalPage);
  await originalPage.locator('#draft').fill('SELECT user_id FROM example_table;');

  const duplicate = await api(url => chrome.tabs.create({ url }), url);
  await closed(duplicate.id);
  assert.equal(await originalPage.locator('#draft').inputValue(), 'SELECT user_id FROM example_table;');
  console.log('通过：同窗口去重，原页未提交输入保持不变。');

  const secondWindow = await api(() => chrome.windows.create({ url: 'about:blank', focused: true }));
  if (process.env.HEADED === '1') {
    console.log('有界面模式：请保持测试浏览器在前台，以验证操作系统焦点。');
    await until(async () => (await api(() => chrome.windows.getAll())).some(window => window.focused), '测试浏览器进入前台');
  }
  const crossWindow = await api(({ url, windowId }) => chrome.tabs.create({ url, windowId }), { url, windowId: secondWindow.id });
  await closed(crossWindow.id);
  if (process.env.HEADED === '1') {
    await until(async () => (await api(() => chrome.windows.getLastFocused())).id === old.windowId, '原窗口获得焦点');
  } else {
    assert.equal(await api(() => focusTrace.at(-1).args[0]), old.windowId);
  }
  assert.equal((await api(id => chrome.tabs.get(id), old.id)).active, true);
  console.log(process.env.HEADED === '1' ? '通过：跨窗口关闭新页，原窗口及原标签获得焦点。' : '通过：跨窗口关闭新页、激活原标签并请求窗口焦点（系统焦点另用有界面模式验证）。');

  const different = await api(url => chrome.tabs.create({ url }), `${base}/report?id=2#sql`);
  const differentHash = await api(url => chrome.tabs.create({ url }), `${base}/report?id=1#result`);
  await settled(different.id);
  await settled(differentHash.id);
  assert.ok((await getTabs()).some(tab => tab.id === different.id));
  assert.ok((await getTabs()).some(tab => tab.id === differentHash.id));
  console.log('通过：不同任务参数、不同锚点分别保留。');

  const redirect = await api(url => chrome.tabs.create({ url }), `${base}/redirect`);
  await closed(redirect.id);
  console.log('通过：HTTP 重定向按最终网址去重。');

  const existingPage = context.pages().find(page => page.url() === `${base}/report?id=2#sql`);
  await existingPage.evaluate(url => { location.href = url; }, url);
  await settled(different.id);
  assert.ok((await getTabs()).some(tab => tab.id === different.id));
  await existingPage.reload();
  await settled(different.id);
  assert.ok((await getTabs()).some(tab => tab.id === different.id));
  console.log('通过：已有页面站内跳转及刷新到重复地址时不自动关闭。');

  const addressTab = await api(url => chrome.tabs.create({ url }), `${base}/address-start`);
  await settled(addressTab.id);
  const addressPage = context.pages().find(page => page.url() === `${base}/address-start`);
  const addressSession = await context.newCDPSession(addressPage);
  await addressSession.send('Page.navigate', { url, transitionType: 'typed' }).catch(error => {
    if (!error.message.includes('closed')) throw error;
  });
  await closed(addressTab.id);
  assert.ok(await api(id => navigationTrace.some(event => event.tabId === id && event.transitionType === 'typed'), addressTab.id));
  assert.equal(await originalPage.locator('#draft').inputValue(), 'SELECT user_id FROM example_table;');
  console.log('通过：已有标签地址栏导航（真实 typed 事件）关闭重复页，保留原页输入。');

  await popup.locator('#enabled').uncheck();
  await until(async () => (await popup.locator('#mode').innerText()).includes('已暂停'), '暂停生效');
  const paused = await api(url => chrome.tabs.create({ url }), url);
  await settled(paused.id);
  await popup.locator('#refresh').click();
  await popup.locator('.group').first().waitFor();
  await popup.setViewportSize({ width: 380, height: 900 });
  await mkdir('test-results', { recursive: true });
  await popup.screenshot({ path: 'test-results/popup.png', clip: { x: 0, y: 0, width: 380, height: Math.min(await popup.locator('body').evaluate(el => el.scrollHeight), 900) } });
  popup.once('dialog', dialog => dialog.accept());
  await popup.getByRole('button', { name: '关闭重复页', exact: true }).first().click();
  await until(async () => (await popup.locator('#status').innerText()).includes('已关闭重复页'), '手动关闭成功');
  console.log('通过：中文界面、暂停和手动确认关闭。');

  await popup.locator('summary').click();
  await popup.locator('#excluded').fill('127.0.0.1');
  await popup.locator('#save').click();
  await until(async () => (await popup.locator('#status').innerText()).includes('已保存'), '排除名单保存');
  await popup.locator('#enabled').check();
  await until(async () => (await popup.locator('#mode').innerText()).includes('已开启'), '恢复生效');
  const excluded = await api(url => chrome.tabs.create({ url }), url);
  await settled(excluded.id);
  assert.ok((await getTabs()).some(tab => tab.id === excluded.id));
  console.log('通过：排除网站允许重复打开。');

  await popup.locator('#excluded').fill('');
  await popup.locator('#save').click();
  await until(async () => (await api(() => chrome.storage.local.get('excludedHosts'))).excludedHosts.length === 0, '排除清空');
  const internals = await context.newPage();
  await internals.goto('chrome://serviceworker-internals');
  const registration = internals.locator('.serviceworker-registration').filter({ hasText: `chrome-extension://${extensionId}/` });
  await registration.locator('[data-command="stop"]').click();
  await until(async () => (await registration.locator('.serviceworker-running-status').innerText()).includes('STOPPED'), '后台停止');
  await popup.reload();
  await popup.locator('#enabled:enabled').waitFor();
  await until(async () => (await registration.locator('.serviceworker-running-status').innerText()).includes('RUNNING'), '后台重新运行');
  // Playwright 可能保留已销毁的 Worker 对象；扩展页仍可正常调用 Chrome API。
  apiPage = popup;
  const afterRestart = await api(url => chrome.tabs.create({ url }), url);
  await closed(afterRestart.id);
  console.log('通过：实际停止并唤醒 MV3 后台后继续去重。');

  assert.deepEqual(errors, [], `浏览器错误：${errors.join('\n')}`);
  console.log('全部浏览器验证通过；截图：test-results/popup.png');
} finally {
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
