#!/usr/bin/env node
// 预下载 Scratch 官方素材库到本地缓存，之后完全离线也能用素材库。
// 用法：npm run fetch-assets            下载全部（约 300~500MB）
//       npm run fetch-assets -- 角色     只下载角色
//       KID_CACHE_DIR=/path npm run fetch-assets   指定缓存目录
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = path.join(ROOT, 'node_modules', 'scratch-gui', 'dist', 'libraries');
const CDN = 'https://cdn.assets.scratch.mit.edu/internalapi/asset';
const APP_NAME = '小小创客'; // 与 package.json 的 productName 保持一致
const CONCURRENCY = 8;

function defaultCacheDir () {
    if (process.env.KID_CACHE_DIR) return process.env.KID_CACHE_DIR;
    const home = os.homedir();
    if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME, 'scratch-asset-cache');
    if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME, 'scratch-asset-cache');
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME, 'scratch-asset-cache');
}

const GROUPS = {
    角色: 'sprites',
    造型: 'costumes',
    背景: 'backdrops',
    声音: 'sounds'
};

function collect (name) {
    const items = JSON.parse(fs.readFileSync(path.join(LIB_DIR, `${name}.json`), 'utf8'));
    const out = new Set();
    for (const it of items) {
        if (it.md5ext) out.add(it.md5ext);
        for (const c of it.costumes || []) if (c.md5ext) out.add(c.md5ext);
        for (const s of it.sounds || []) if (s.md5ext) out.add(s.md5ext);
    }
    return out;
}

async function main () {
    const args = process.argv.slice(2).filter(a => a !== '--');
    const wanted = args.length
        ? args.map(a => GROUPS[a] || a).filter(n => Object.values(GROUPS).includes(n))
        : Object.values(GROUPS);
    if (!wanted.length) {
        console.error('可用的分类：' + Object.keys(GROUPS).join(' / '));
        process.exit(1);
    }

    const cacheDir = defaultCacheDir();
    await fsp.mkdir(cacheDir, { recursive: true });

    const all = new Set();
    for (const name of wanted) for (const m of collect(name)) all.add(m);

    const todo = [];
    for (const md5ext of all) {
        if (!fs.existsSync(path.join(cacheDir, md5ext))) todo.push(md5ext);
    }

    console.log(`缓存目录：${cacheDir}`);
    console.log(`分类：${wanted.join(', ')}`);
    console.log(`共 ${all.size} 个素材，其中 ${all.size - todo.length} 个已缓存，需要下载 ${todo.length} 个。\n`);
    if (!todo.length) return console.log('已经全部下载好了 🎉');

    const total = todo.length;
    let done = 0;
    let failed = 0;
    let bytes = 0;
    const started = Date.now();

    const worker = async () => {
        for (;;) {
            const md5ext = todo.pop();
            if (!md5ext) return;
            let ok = false;
            for (let attempt = 0; attempt < 3 && !ok; attempt++) {
                try {
                    const resp = await fetch(`${CDN}/${md5ext}/get/`);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const buf = Buffer.from(await resp.arrayBuffer());
                    const tmp = path.join(cacheDir, `.${md5ext}.tmp`);
                    await fsp.writeFile(tmp, buf);
                    await fsp.rename(tmp, path.join(cacheDir, md5ext));
                    bytes += buf.length;
                    ok = true;
                } catch (e) {
                    if (attempt === 2) {
                        failed++;
                        console.error(`  ✗ ${md5ext}: ${e.message}`);
                    } else {
                        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
                    }
                }
            }
            done++;
            if (done % 25 === 0 || !todo.length) {
                const pct = ((done / total) * 100).toFixed(1);
                process.stdout.write(`\r进度 ${done}/${total} (${pct}%) · ${(bytes / 1048576).toFixed(1)} MB   `);
            }
        }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\n\n完成：成功 ${done - failed} 个，失败 ${failed} 个，共 ${(bytes / 1048576).toFixed(1)} MB，用时 ${Math.round((Date.now() - started) / 1000)} 秒。`);
    if (failed) console.log('失败的可以再跑一次这个命令，已下载的会自动跳过。');
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
