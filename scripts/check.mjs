import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';

const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['tabs', 'storage', 'webNavigation']);
assert.equal(manifest.incognito, 'not_allowed');
for (const field of ['host_permissions', 'content_scripts', 'externally_connectable']) assert.equal(manifest[field], undefined);
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) {
  assert.ok(statSync(path.join('extension', file)).isFile());
}
let size = 0;
function check(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { check(file); continue; }
    size += statSync(file).size;
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file]);
    if (/\.(js|html|css)$/.test(file)) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\beval\s*\(|\bfetch\s*\(|\bXMLHttpRequest\b|innerHTML/);
    }
  }
}
check('extension');
assert.ok(size < 100_000, `扩展超过 100 KB：${size}`);
console.log(`检查通过：Manifest V3、三项权限、无远程请求；扩展 ${size} 字节。`);
