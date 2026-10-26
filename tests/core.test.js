import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, DEFAULT_SETTINGS, pageKey, normalizeHosts, duplicateGroups } from '../extension/core.js';

const URL_A = 'https://work.example/report?id=100&project=demo#sql';
const CORAL = 'https://data.bytedance.net/coral/datamap/result?query=example_table';
const tab = (id, extra = {}) => ({ id, windowId: 1, url: URL_A, status: 'complete', active: false, ...extra });

function fixture(initial = [tab(1)]) {
  const tabs = new Map(initial.map(t => [t.id, structuredClone(t)]));
  const local = {};
  const session = {};
  const calls = [];
  let time = 100_000;
  const area = data => ({
    get: async defaults => structuredClone({ ...defaults, ...data }),
    set: async value => Object.assign(data, structuredClone(value))
  });
  const api = {
    storage: { local: area(local), session: area(session) },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    tabs: {
      query: async () => structuredClone([...tabs.values()]),
      get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return structuredClone(tabs.get(id)); },
      update: async (id, changes) => { calls.push(['activate', id]); Object.assign(tabs.get(id), changes); },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id); }
    },
    windows: {
      get: async () => ({ state: 'minimized' }),
      update: async (id, changes) => { calls.push(['window', id, changes]); }
    }
  };
  return {
    api, tabs, calls, session, local,
    controller: () => createController(api, () => time),
    advance: ms => { time += ms; },
    async add(c, t) { tabs.set(t.id, t); await c.created(t); }
  };
}

test('完整 URL 区分任务、查询参数、顺序、锚点和协议', () => {
  const key = pageKey(tab(1), DEFAULT_SETTINGS);
  for (const url of [URL_A.replace('100', '101'), URL_A.replace('#sql', '#result'),
    URL_A.replace('id=100&project=demo', 'project=demo&id=100'), URL_A.replace('https:', 'http:')]) {
    assert.notEqual(pageKey(tab(2, { url }), DEFAULT_SETTINGS), key);
  }
  for (const url of ['chrome://newtab/', 'file:///tmp/a', 'about:blank', 'bad url']) {
    assert.equal(pageKey(tab(3, { url }), DEFAULT_SETTINGS), null);
  }
  assert.equal(pageKey(tab(4, { incognito: true }), DEFAULT_SETTINGS), null);
});

test('排除域名含子域名，但不误匹配相似域名', () => {
  const settings = { ...DEFAULT_SETTINGS, excludedHosts: normalizeHosts('EXAMPLE.com\nhttps://example.com/') };
  assert.deepEqual(settings.excludedHosts, ['example.com']);
  assert.equal(pageKey(tab(1, { url: 'https://a.example.com/' }), settings), null);
  assert.ok(pageKey(tab(1, { url: 'https://notexample.com/' }), settings));
  assert.throws(() => normalizeHosts('example.com/path'));
  assert.throws(() => normalizeHosts('*.example.com'));
});

test('Coral 搜索页默认分组参数等价，搜索词及其他业务参数仍区分', () => {
  const key = url => pageKey(tab(1, { url }), DEFAULT_SETTINGS);
  for (const url of [CORAL + '#group=default', CORAL + '&groupName=default',
    CORAL.replace('?query=', '?groupName=default&query=') + '#group=default']) {
    assert.equal(key(url), key(CORAL));
  }
  for (const url of [CORAL + '&groupName=other#group=default', CORAL + '#group=other',
    CORAL.replace('example_table', 'another_table'), CORAL + '&filter=1',
    CORAL + '&groupName=default&groupName=other', CORAL + '#group=default&view=sql']) {
    assert.notEqual(key(url), key(CORAL));
  }
  for (const url of [CORAL.replace('data.bytedance.net', 'work.example'),
    CORAL.replace('/result?', '/detail?')]) {
    assert.notEqual(key(url), key(url + '#group=default'));
  }
});

test('Coral 地址栏导航加载中补默认分组，仍去重并保留原页', async () => {
  const f = fixture([tab(1, { url: CORAL }), tab(2, { url: CORAL, status: 'loading' })]);
  const c = f.controller();
  await c.committed(addressNavigation(2, { url: CORAL }));
  Object.assign(f.tabs.get(2), { url: CORAL + '#group=default', status: 'complete' });
  await c.updated(2);
  assert.deepEqual([...f.tabs.keys()], [1]);
});

test('Coral 手动关闭接受页面的实际 URL，搜索词变化后拒绝关闭', async () => {
  const actual = CORAL + '&groupName=default#group=default';
  const f = fixture([tab(1, { url: CORAL }), tab(2, { url: actual })]);
  assert.equal(await f.controller().closeDuplicate(2, 1, actual), true);
  const changed = fixture([tab(1, { url: CORAL }), tab(2, { url: CORAL + '2' })]);
  assert.equal(await changed.controller().closeDuplicate(2, 1, actual), false);
});

test('跨窗口重复页关闭新页，激活旧页并还原最小化窗口', async () => {
  const f = fixture([tab(1, { windowId: 9 })]);
  const c = f.controller();
  await f.add(c, tab(2, { windowId: 10 }));
  assert.deepEqual([...f.tabs.keys()], [1]);
  assert.deepEqual(f.calls, [
    ['activate', 1], ['window', 9, { focused: true, state: 'normal' }], ['remove', 2],
    ['activate', 1], ['window', 9, { focused: true, state: 'normal' }]
  ]);
});

test('不同参数及锚点、固定页、声音页和无痕页不自动关闭', async () => {
  for (const extra of [{ url: URL_A + 'x' }, { pinned: true }, { audible: true }, { incognito: true }]) {
    const f = fixture();
    await f.add(f.controller(), tab(2, extra));
    assert.equal(f.tabs.size, 2);
    assert.equal(f.calls.length, 0);
  }
});

test('只在首个网页加载完成时判断，HTTP 重定向保留最终 URL', async () => {
  const f = fixture();
  const c = f.controller();
  await f.add(c, tab(2, { url: 'about:blank', pendingUrl: 'https://work.example/redirect', status: 'loading' }));
  assert.equal(f.tabs.size, 2);
  Object.assign(f.tabs.get(2), { url: URL_A, status: 'complete', pendingUrl: undefined });
  await c.updated(2);
  assert.equal(f.tabs.size, 1);
});

test('已有页跳转、刷新和首次加载结束后的 SPA 跳转都不自动关闭', async () => {
  const f = fixture([tab(1), tab(2)]);
  const c = f.controller();
  await c.updated(2);
  await f.add(c, tab(3, { url: 'https://work.example/unique' }));
  f.tabs.get(3).url = URL_A;
  await c.updated(3);
  assert.equal(f.tabs.size, 3);
});

const addressNavigation = (id, extra = {}) => ({
  tabId: id, frameId: 0, url: URL_A, transitionType: 'typed',
  transitionQualifiers: ['from_address_bar'], ...extra
});

test('已有标签粘贴网址回车：等待加载完成，再关闭当前页并保留原页', async () => {
  const f = fixture([tab(1), tab(2, { status: 'loading' })]);
  const c = f.controller();
  await c.committed(addressNavigation(2));
  assert.equal(f.tabs.size, 2);
  f.tabs.get(2).status = 'complete';
  await c.updated(2);
  assert.deepEqual([...f.tabs.keys()], [1]);
});

test('地址栏选择建议产生 link 类型时仍可去重', async () => {
  const f = fixture([tab(1), tab(2)]);
  await f.controller().committed(addressNavigation(2, { transitionType: 'link' }));
  assert.deepEqual([...f.tabs.keys()], [1]);
});

test('刷新、前进后退、站内点击、表单和子框架不会激活已有页去重', async () => {
  for (const extra of [
    { transitionType: 'reload' },
    { transitionQualifiers: ['from_address_bar', 'forward_back'] },
    { transitionType: 'link', transitionQualifiers: [] },
    { transitionType: 'form_submit', transitionQualifiers: [] },
    { frameId: 1 }
  ]) {
    const f = fixture([tab(1), tab(2)]);
    const c = f.controller();
    await c.committed(addressNavigation(2, extra));
    await c.updated(2);
    assert.equal(f.tabs.size, 2);
  }
});

test('地址栏资格不沿用到后续站内导航，也不关闭不同查询的页面', async () => {
  const f = fixture([tab(1), tab(2, { status: 'loading' })]);
  const c = f.controller();
  await c.committed(addressNavigation(2));
  await c.committed(addressNavigation(2, { transitionType: 'link', transitionQualifiers: [] }));
  f.tabs.get(2).status = 'complete';
  await c.updated(2);
  assert.equal(f.tabs.size, 2);
  f.tabs.get(2).url = URL_A.replace('100', '101');
  await c.committed(addressNavigation(2, { url: f.tabs.get(2).url }));
  assert.equal(f.tabs.size, 2);
});

test('地址栏导航同样遵守暂停、排除、固定、声音和无痕保护', async () => {
  for (const extra of [{ pinned: true }, { audible: true }, { incognito: true }]) {
    const f = fixture([tab(1), tab(2, extra)]);
    await f.controller().committed(addressNavigation(2));
    assert.equal(f.tabs.size, 2);
  }
  for (const settings of [
    { enabled: false, excludedHosts: [] },
    { enabled: true, excludedHosts: ['work.example'] }
  ]) {
    const f = fixture([tab(1), tab(2)]);
    const c = f.controller();
    await c.setSettings(settings);
    await c.committed(addressNavigation(2));
    assert.equal(f.tabs.size, 2);
  }
});

test('新空白页可稍后输入地址；慢加载超过一分钟不再自动关闭', async () => {
  const f = fixture();
  const c = f.controller();
  await f.add(c, tab(2, { url: 'chrome://newtab/' }));
  f.advance(90_000);
  Object.assign(f.tabs.get(2), { url: URL_A, status: 'loading' });
  await c.updated(2);
  f.advance(61_000);
  f.tabs.get(2).status = 'complete';
  await c.updated(2);
  assert.equal(f.tabs.size, 2);
});

test('暂停期间不关闭，恢复后不追溯，只处理之后新开的页', async () => {
  const f = fixture();
  const c = f.controller();
  await c.setSettings({ enabled: false, excludedHosts: [] });
  await f.add(c, tab(2));
  await c.setSettings(DEFAULT_SETTINGS);
  await c.updated(2);
  assert.equal(f.tabs.size, 2);
  await f.add(c, tab(3));
  assert.equal(f.tabs.size, 2);
  assert.ok(f.tabs.has(1));
});

test('网站排除实际阻止关闭', async () => {
  const f = fixture();
  const c = f.controller();
  await c.setSettings({ enabled: true, excludedHosts: ['example'] });
  await f.add(c, tab(2));
  assert.equal(f.tabs.size, 2);
});

test('并发打开只保留一页，重复事件不会把两页都关掉', async () => {
  const f = fixture([]);
  const c = f.controller();
  f.tabs.set(1, tab(1));
  f.tabs.set(2, tab(2));
  await Promise.all([c.created(tab(1)), c.created(tab(2)), c.updated(1), c.updated(2)]);
  assert.equal(f.tabs.size, 1);
});

test('后台休眠后，重建控制器仍可处理尚未加载完成的新页', async () => {
  const f = fixture();
  await f.add(f.controller(), tab(2, { status: 'loading' }));
  f.tabs.get(2).status = 'complete';
  await f.controller().updated(2);
  assert.equal(f.tabs.size, 1);
});

test('浏览器启动宽限期间不处理恢复页，之后恢复正常', async () => {
  const f = fixture();
  const c = f.controller();
  await c.startup();
  await f.add(c, tab(2));
  assert.equal(f.tabs.size, 2);
  f.advance(10_001);
  await f.add(c, tab(3));
  assert.equal(f.tabs.size, 2);
});

test('候选目标已关闭或改址时保留新页，手动操作也重新核对 URL', async () => {
  const f = fixture([tab(1), tab(2)]);
  const c = f.controller();
  f.tabs.get(1).url = 'https://work.example/changed';
  assert.equal(await c.closeDuplicate(2, 1, URL_A), false);
  f.tabs.delete(1);
  assert.equal(await c.closeDuplicate(2, 1, URL_A), false);
  assert.ok(f.tabs.has(2));
});

test('激活窗口过程中目标改址，不关闭新页', async () => {
  const f = fixture();
  f.api.windows.update = async () => { f.tabs.get(1).url = 'https://work.example/new'; };
  await f.add(f.controller(), tab(2));
  assert.equal(f.tabs.size, 2);
});

test('切回窗口失败时保留新页，队列仍可继续处理', async () => {
  const f = fixture();
  const c = f.controller();
  f.api.windows.update = async () => { throw new Error('Window gone'); };
  await assert.rejects(f.add(c, tab(2)), /Window gone/);
  assert.equal(f.tabs.size, 2);
  assert.equal((await c.snapshot()).groups.length, 1);
});

test('重复列表优先保留固定页，保护声音页，手动关闭不抢焦点', async () => {
  const f = fixture([tab(1), tab(2, { pinned: true }), tab(3, { audible: true })]);
  const groups = duplicateGroups([...f.tabs.values()], DEFAULT_SETTINGS);
  assert.equal(groups[0].keep.id, 2);
  assert.equal(groups[0].duplicates.find(t => t.id === 3).closable, false);
  assert.equal(await f.controller().closeDuplicate(1, 2, URL_A), true);
  assert.deepEqual(f.calls, [['remove', 1]]);
});
