// SPDX-License-Identifier: GPL-3.0-only
// 中文精简分支，源自 Peuj/duplicate-tabs-closer。改写日期：2026-10-27。
export const DEFAULT_SETTINGS = { enabled: true, excludedHosts: [] };
const INITIAL_LOAD_MS = 60_000;
const RESTORE_GRACE_MS = 10_000;

export function normalizeHosts(text) {
  return [...new Set(text.split(/\s+/).filter(Boolean).map(value => {
    let url;
    try { url = new URL(value.includes('://') ? value : `https://${value}`); }
    catch { throw new Error('域名格式不正确，请每行填写一个域名。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.hostname.includes('*') || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('请输入域名，每行一个；不要填写路径、端口或通配符。');
    }
    return url.hostname.toLowerCase();
  }))];
}

export function pageKey(tab, settings) {
  if (!tab?.url || tab.incognito) return null;
  try {
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (settings.excludedHosts.some(host =>
      url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    // Coral 搜索页会在初始化时增删默认分组；只归一化已验证的默认值。
    // 不处理详情页、非默认分组、其他锚点或重复参数。
    const groups = url.searchParams.getAll('groupName');
    if (url.origin === 'https://data.bytedance.net' && url.pathname === '/coral/datamap/result' &&
        url.searchParams.getAll('query').length === 1 &&
        (groups.length === 0 || (groups.length === 1 && groups[0] === 'default')) &&
        (!url.hash || url.hash === '#group=default')) {
      url.searchParams.delete('groupName');
      url.hash = '';
    }
    // 其他网址保留路径、参数顺序和锚点；不按标题猜测同一页面。
    return url.href;
  } catch {
    return null;
  }
}

function canClose(tab) {
  return !tab.pinned && !tab.audible && !tab.pendingUrl && tab.status === 'complete';
}

export function duplicateGroups(tabs, settings) {
  const groups = new Map();
  for (const tab of tabs) {
    const key = pageKey(tab, settings);
    if (!key || tab.pendingUrl || tab.status !== 'complete') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }
  return [...groups.values()].filter(group => group.length > 1).map(group => {
    group.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || Number(!!b.audible) - Number(!!a.audible));
    return {
      keep: group[0],
      duplicates: group.slice(1).map(tab => ({ ...tab, closable: canClose(tab) }))
    };
  });
}

export function createController(api, now = Date.now) {
  let queue = Promise.resolve();
  let initialized = false;
  let settings;
  let session;

  async function init() {
    if (initialized) return;
    settings = await api.storage.local.get(DEFAULT_SETTINGS);
    session = await api.storage.session.get({ pending: {}, skipUntil: 0 });
    const ids = new Set((await api.tabs.query({})).map(tab => String(tab.id)));
    for (const id of Object.keys(session.pending)) {
      if (!ids.has(id)) delete session.pending[id];
    }
    initialized = true;
  }

  function run(task) {
    const result = queue.then(async () => { await init(); return task(); });
    queue = result.catch(() => {});
    return result;
  }

  const saveSession = () => api.storage.session.set(session);
  async function getTab(id) {
    try { return await api.tabs.get(id); } catch { return null; }
  }
  async function badge() {
    await api.action.setBadgeText({ text: settings.enabled ? '' : '停' });
    await api.action.setBadgeBackgroundColor({ color: '#64748b' });
  }

  async function focus(tab) {
    await api.tabs.update(tab.id, { active: true });
    const window = await api.windows.get(tab.windowId);
    await api.windows.update(tab.windowId, {
      focused: true,
      ...(window.state === 'minimized' ? { state: 'normal' } : {})
    });
  }

  async function closePair(id, keepId, expectedUrl, automatic) {
    const [tab, keep] = await Promise.all([getTab(id), getTab(keepId)]);
    const key = pageKey(tab, settings);
    if (!tab || !keep || id === keepId || !key || key !== pageKey({ ...tab, url: expectedUrl }, settings) ||
        key !== pageKey(keep, settings) || !canClose(tab) ||
        keep.pendingUrl || keep.status !== 'complete') return false;
    // 焦点切换失败时不关闭源页；不重新加载保留页，以保留编辑状态。
    if (automatic) await focus(keep);
    const [latest, target] = await Promise.all([getTab(id), getTab(keepId)]);
    if (!latest || !target || !canClose(latest) || target.pendingUrl ||
        target.status !== 'complete' || pageKey(latest, settings) !== key ||
        pageKey(target, settings) !== key) return false;
    await api.tabs.remove(id);
    // 关闭另一个窗口的活动页可能让 Chrome 再次改变焦点，关闭后恢复目标窗口。
    if (automatic) await focus(target);
    return true;
  }

  async function inspect(id) {
    const candidate = session.pending[id];
    if (!candidate) return;
    const tab = await getTab(id);
    if (!tab || !settings.enabled || (now() < session.skipUntil && !candidate.committedUrl)) {
      delete session.pending[id];
      await saveSession();
      return;
    }
    // 新标签页可以先空白很久，计时从首次 HTTP(S) 导航开始。
    const url = tab.pendingUrl || tab.url;
    if (!url || !/^https?:\/\//.test(url)) return;
    candidate.startedAt ??= now();
    if (now() - candidate.startedAt > INITIAL_LOAD_MS) {
      delete session.pending[id];
      await saveSession();
      return;
    }
    if (tab.pendingUrl || tab.status !== 'complete') {
      await saveSession();
      return;
    }
    // 首个网页加载完成后结束资格，后续编辑和站内跳转不触发。
    delete session.pending[id];
    await saveSession();
    // 地址栏导航完成前又跳到其他页面时，旧导航资格不能沿用。
    const key = pageKey(tab, settings);
    if (candidate.committedUrl && key !== pageKey({ ...tab, url: candidate.committedUrl }, settings)) return;
    if (!key || !canClose(tab)) return;
    const tabs = await api.tabs.query({});
    const keep = tabs.find(other => other.id !== id && !session.pending[other.id] &&
      !other.pendingUrl && other.status === 'complete' && pageKey(other, settings) === key);
    if (keep) await closePair(id, keep.id, key, true);
  }

  return {
    ready: () => run(badge),
    created: tab => run(async () => {
      if (!settings.enabled || tab.incognito || now() < session.skipUntil) return;
      session.pending[tab.id] = {};
      await saveSession();
      await inspect(tab.id);
    }),
    updated: id => run(() => inspect(id)),
    committed: details => run(async () => {
      if (details.frameId !== 0) return;
      const qualifiers = details.transitionQualifiers || [];
      const fromAddressBar = details.transitionType !== 'reload' &&
        !qualifiers.includes('forward_back') &&
        (details.transitionType === 'typed' || qualifiers.includes('from_address_bar'));
      if (!fromAddressBar) {
        // 页面点击、表单提交或后退不能继承前一次地址栏导航的去重资格。
        if (session.pending[details.tabId]?.committedUrl) {
          delete session.pending[details.tabId];
          await saveSession();
        }
        return;
      }
      if (!settings.enabled || !/^https?:\/\//.test(details.url)) return;
      session.pending[details.tabId] = { startedAt: now(), committedUrl: details.url };
      await saveSession();
      await inspect(details.tabId);
    }),
    removed: id => run(async () => {
      delete session.pending[id];
      await saveSession();
    }),
    startup: () => run(async () => {
      session = { pending: {}, skipUntil: now() + RESTORE_GRACE_MS };
      await saveSession();
      await badge();
    }),
    snapshot: () => run(async () => ({
      settings,
      groups: duplicateGroups(await api.tabs.query({}), settings)
    })),
    setSettings: value => run(async () => {
      settings = {
        enabled: value.enabled === true,
        excludedHosts: normalizeHosts(value.excludedHosts.join('\n'))
      };
      await api.storage.local.set(settings);
      session.pending = {};
      await saveSession();
      await badge();
      return settings;
    }),
    closeDuplicate: (id, keepId, url) => run(() => closePair(id, keepId, url, false)),
    focus: id => run(async () => {
      const tab = await getTab(id);
      if (tab) await focus(tab);
    })
  };
}
