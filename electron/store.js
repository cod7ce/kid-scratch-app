'use strict';
// 作品的本地存储：每个作品一个文件夹，含 project.sb3 / meta.json / thumb.png / 历史版本
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { paths, ensureDirs } = require('./paths');

const MAX_HISTORY = 20;
const HISTORY_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟留一个历史版本

const two = n => String(n).padStart(2, '0');

function stamp (d = new Date()) {
    return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function newId () {
    return `p${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
}

const projectDir = id => path.join(paths.projectsDir, id);
const sb3Path = id => path.join(projectDir(id), 'project.sb3');
const metaPath = id => path.join(projectDir(id), 'meta.json');
const thumbPath = id => path.join(projectDir(id), 'thumb.png');
const historyDir = id => path.join(projectDir(id), '历史版本');

function safeId (id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('非法的作品 ID');
    return id;
}

async function readMeta (id) {
    try {
        return JSON.parse(await fsp.readFile(metaPath(id), 'utf8'));
    } catch (e) {
        return null;
    }
}

async function writeMeta (id, meta) {
    await fsp.mkdir(projectDir(id), { recursive: true });
    await fsp.writeFile(metaPath(id), JSON.stringify(meta, null, 2), 'utf8');
}

async function writeFileAtomic (file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
}

async function list () {
    ensureDirs();
    let entries = [];
    try {
        entries = await fsp.readdir(paths.projectsDir, { withFileTypes: true });
    } catch (e) {
        return [];
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
        const meta = await readMeta(ent.name);
        if (!meta) continue;
        let size = 0;
        try {
            size = (await fsp.stat(sb3Path(ent.name))).size;
        } catch (e) { /* 还没保存过 */ }
        out.push({
            id: ent.name,
            name: meta.name || '未命名作品',
            created: meta.created || 0,
            modified: meta.modified || meta.created || 0,
            size,
            hasThumb: fs.existsSync(thumbPath(ent.name))
        });
    }
    out.sort((a, b) => b.modified - a.modified);
    return out;
}

async function create (name) {
    ensureDirs();
    const id = newId();
    const now = Date.now();
    await writeMeta(id, { name: (name || '我的新作品').trim() || '我的新作品', created: now, modified: now, lastHistory: 0 });
    return { id };
}

async function read (id) {
    safeId(id);
    try {
        const buf = await fsp.readFile(sb3Path(id));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch (e) {
        return null; // 新作品，还没有内容
    }
}

async function save (id, arrayBuffer, thumbDataUrl) {
    safeId(id);
    const meta = (await readMeta(id)) || { name: '未命名作品', created: Date.now(), lastHistory: 0 };
    const data = Buffer.from(arrayBuffer);
    if (!data.length) throw new Error('空的作品数据，已跳过保存');

    // 先把上一版挪进历史版本（限频），再覆盖主文件
    const now = Date.now();
    if (fs.existsSync(sb3Path(id)) && now - (meta.lastHistory || 0) > HISTORY_INTERVAL_MS) {
        try {
            await fsp.mkdir(historyDir(id), { recursive: true });
            await fsp.copyFile(sb3Path(id), path.join(historyDir(id), `${stamp(new Date(meta.modified || now))}.sb3`));
            meta.lastHistory = now;
            await pruneHistory(id);
        } catch (e) { /* 历史版本失败不影响主保存 */ }
    }

    await writeFileAtomic(sb3Path(id), data);
    if (typeof thumbDataUrl === 'string' && thumbDataUrl.startsWith('data:image/png;base64,')) {
        try {
            await writeFileAtomic(thumbPath(id), Buffer.from(thumbDataUrl.split(',')[1], 'base64'));
        } catch (e) { /* 缩略图失败无所谓 */ }
    }
    meta.modified = now;
    await writeMeta(id, meta);
    return { ok: true, modified: now, size: data.length };
}

async function pruneHistory (id) {
    const dir = historyDir(id);
    let files = [];
    try {
        files = (await fsp.readdir(dir)).filter(f => f.endsWith('.sb3')).sort();
    } catch (e) {
        return;
    }
    while (files.length > MAX_HISTORY) {
        await fsp.unlink(path.join(dir, files.shift())).catch(() => {});
    }
}

async function listHistory (id) {
    safeId(id);
    let files = [];
    try {
        files = (await fsp.readdir(historyDir(id))).filter(f => f.endsWith('.sb3'));
    } catch (e) {
        return [];
    }
    const out = [];
    for (const f of files) {
        const st = await fsp.stat(path.join(historyDir(id), f)).catch(() => null);
        if (st) out.push({ file: f, time: st.mtimeMs, size: st.size });
    }
    return out.sort((a, b) => b.time - a.time);
}

async function readHistory (id, file) {
    safeId(id);
    if (!/^[0-9-]+\.sb3$/.test(file)) throw new Error('非法的历史版本文件名');
    const buf = await fsp.readFile(path.join(historyDir(id), file));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function rename (id, name) {
    safeId(id);
    const meta = await readMeta(id);
    if (!meta) throw new Error('找不到这个作品');
    meta.name = (name || '').trim() || meta.name;
    meta.modified = Date.now();
    await writeMeta(id, meta);
    return { ok: true, name: meta.name };
}

async function duplicate (id) {
    safeId(id);
    const meta = await readMeta(id);
    if (!meta) throw new Error('找不到这个作品');
    const { id: newProjectId } = await create(`${meta.name} 的副本`);
    if (fs.existsSync(sb3Path(id))) await fsp.copyFile(sb3Path(id), sb3Path(newProjectId));
    if (fs.existsSync(thumbPath(id))) await fsp.copyFile(thumbPath(id), thumbPath(newProjectId));
    return { id: newProjectId };
}

// 删除 = 移到「回收站」文件夹，孩子误删也能找回
async function remove (id) {
    safeId(id);
    ensureDirs();
    const meta = await readMeta(id);
    const label = `${stamp()}-${(meta && meta.name ? meta.name : id).replace(/[/\\:*?"<>|]/g, '_')}`;
    await fsp.rename(projectDir(id), path.join(paths.trashDir, label));
    return { ok: true };
}

async function importSb3 (filePath, name) {
    const data = await fsp.readFile(filePath);
    const { id } = await create(name || path.basename(filePath, path.extname(filePath)));
    await writeFileAtomic(sb3Path(id), data);
    return { id };
}

async function exportSb3 (id, targetPath) {
    safeId(id);
    await fsp.copyFile(sb3Path(id), targetPath);
    return { ok: true };
}

module.exports = {
    list, create, read, save, rename, duplicate, remove,
    importSb3, exportSb3, listHistory, readHistory, readMeta,
    projectDir, sb3Path, thumbPath
};
