import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

execFileSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit' });
const { version } = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
const name = `tab-return-lite-${version}`;
const directory = path.resolve('dist', name);
// 只重建本脚本的产物目录，不触碰用户浏览器配置。
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
cpSync('extension', directory, { recursive: true });
for (const file of ['LICENSE', 'NOTICE.md', 'README.md']) cpSync(file, path.join(directory, file));
cpSync('docs', path.join(directory, 'docs'), { recursive: true });
const archive = path.resolve('dist', `${name}.zip`);
rmSync(archive, { force: true });
execFileSync('zip', ['-qr', archive, name], { cwd: path.resolve('dist') });
console.log(`安装包：${archive}（${statSync(archive).size} 字节）`);
