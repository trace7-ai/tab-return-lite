// SPDX-License-Identifier: GPL-3.0-only
import { createController } from './core.js';

const controller = createController(chrome);
const report = error => console.error('回到已打开：', error);

// MV3 唤醒时，先同步注册事件，再做异步初始化。
chrome.tabs.onCreated.addListener(tab => { controller.created(tab).catch(report); });
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (changes.status || changes.url) controller.updated(id).catch(report);
});
chrome.tabs.onRemoved.addListener(id => { controller.removed(id).catch(report); });
chrome.runtime.onStartup.addListener(() => { controller.startup().catch(report); });
chrome.runtime.onInstalled.addListener(() => { controller.ready().catch(report); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  let action;
  switch (message.type) {
    case 'snapshot': action = () => controller.snapshot(); break;
    case 'settings': action = () => controller.setSettings(message.value); break;
    case 'focus': action = () => controller.focus(message.id); break;
    case 'close': action = () => controller.closeDuplicate(message.id, message.keepId, message.url); break;
    default: return false;
  }
  action().then(data => reply({ ok: true, data }), error => reply({ ok: false, error: error.message }));
  return true;
});
controller.ready().catch(report);
