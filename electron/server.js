'use strict';
// 本地静态服务器：托管界面、scratch-gui 预编译产物、素材库，并做官方素材的本地缓存代理。
// 用 http 而不是 file:// 是为了让 scratch-gui 的 fetch / Worker / 跨目录资源都能正常工作。
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ASSET_CDN = 'https://cdn.assets.scratch.mit.edu/internalapi/asset';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.hex': 'application/octet-stream',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8'
};

const mimeOf = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

function resolveWithin (root, relUrlPath) {
    let rel;
    try {
        rel = decodeURIComponent(relUrlPath);
    } catch (e) {
        return null;
    }
    if (rel.includes('\0')) return null;
    const abs = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    const rootAbs = path.resolve(root);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
    return abs;
}

async function serveFile (res, filePath, { immutable = false } = {}) {
    if (!filePath) return false;
    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch (e) {
        return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, {
        'Content-Type': mimeOf(filePath),
        'Content-Length': stat.size,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    });
    await new Promise((resolve, reject) => {
        const s = fs.createReadStream(filePath);
        s.on('error', reject);
        s.on('end', resolve);
        s.pipe(res);
    }).catch(() => {});
    return true;
}

function sendJson (res, obj, status = 200) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Content-Length': body.length });
    res.end(body);
}

function notFound (res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
}

// ---- 官方素材缓存 --------------------------------------------------------
const inflight = new Map();

function looksLikeMd5Ext (name) {
    return /^[a-zA-Z0-9]{8,64}\.[a-zA-Z0-9]{1,8}$/.test(name);
}

async function fetchAndCache (md5ext, cacheDir) {
    if (inflight.has(md5ext)) return inflight.get(md5ext);
    const p = (async () => {
        const resp = await fetch(`${ASSET_CDN}/${md5ext}/get/`);
        if (!resp.ok) throw new Error(`CDN ${resp.status}`);
        const buf = Buffer.from(await resp.arrayBuffer());
        await fsp.mkdir(cacheDir, { recursive: true });
        const tmp = path.join(cacheDir, `.${md5ext}.${process.pid}.tmp`);
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, path.join(cacheDir, md5ext));
        return buf;
    })();
    inflight.set(md5ext, p);
    p.finally(() => inflight.delete(md5ext));
    return p;
}

// ---- 素材库列表 ----------------------------------------------------------
const IMAGE_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
const SOUND_EXT = new Set(['.wav', '.mp3', '.ogg', '.m4a']);

async function readDirSafe (dir) {
    try {
        return await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
        return [];
    }
}

async function scanUserAssets (myAssetsDir) {
    const out = { sprites: [], backdrops: [], sounds: [] };
    const map = [
        ['角色', 'sprites', IMAGE_EXT],
        ['背景', 'backdrops', IMAGE_EXT],
        ['声音', 'sounds', SOUND_EXT]
    ];
    for (const [folder, key, exts] of map) {
        const dir = path.join(myAssetsDir, folder);
        for (const ent of await readDirSafe(dir)) {
            if (!ent.isFile() || ent.name.startsWith('.')) continue;
            const ext = path.extname(ent.name).toLowerCase();
            if (!exts.has(ext)) continue;
            out[key].push({
                name: path.basename(ent.name, ext),
                url: `/my-assets/${encodeURIComponent(folder)}/${encodeURIComponent(ent.name)}`,
                ext: ext.slice(1),
                source: 'user'
            });
        }
    }
    return out;
}

async function readBuiltinLibrary (builtinLibDir) {
    try {
        const raw = await fsp.readFile(path.join(builtinLibDir, 'library.json'), 'utf8');
        const data = JSON.parse(raw);
        const fix = (arr, folder) => (arr || []).map(it => ({
            name: it.name,
            url: `/library/${folder}/${encodeURIComponent(it.file)}`,
            ext: path.extname(it.file).slice(1).toLowerCase(),
            tags: it.tags || [],
            source: 'builtin'
        }));
        return {
            sprites: fix(data.sprites, 'sprites'),
            backdrops: fix(data.backdrops, 'backdrops'),
            sounds: fix(data.sounds, 'sounds')
        };
    } catch (e) {
        return { sprites: [], backdrops: [], sounds: [] };
    }
}

// ---- 服务器 --------------------------------------------------------------
function createServer (opts) {
    const { rendererDir, guiDir, reactDir, reactDomDir, builtinLibDir, myAssetsDir, assetCacheDir, getProjectsDir } = opts;

    const mounts = [
        ['/gui/', guiDir, true],
        // scratch-blocks 内部用的是相对页面的 "./static/blocks-media/..."，所以再挂一份到根
        ['/static/', path.join(guiDir, 'static'), true],
        ['/vendor/react/', reactDir, true],
        ['/vendor/react-dom/', reactDomDir, true],
        ['/library/', builtinLibDir, false],
        ['/app/', rendererDir, false]
    ];

    const server = http.createServer(async (req, res) => {
        try {
            const u = new URL(req.url, 'http://127.0.0.1');
            let pathname = u.pathname;
            if (pathname === '/') pathname = '/index.html';

            // 官方素材：本地缓存优先，未命中才联网下载并落盘
            const assetMatch = pathname.match(/^\/scratch-assets\/internalapi\/asset\/([^/]+)\/get\/?$/);
            if (assetMatch) {
                const md5ext = decodeURIComponent(assetMatch[1]);
                if (!looksLikeMd5Ext(md5ext)) return notFound(res);
                const cached = path.join(assetCacheDir, md5ext);
                if (await serveFile(res, cached, { immutable: true })) return;
                try {
                    const buf = await fetchAndCache(md5ext, assetCacheDir);
                    res.writeHead(200, {
                        'Content-Type': mimeOf(md5ext),
                        'Content-Length': buf.length,
                        'Cache-Control': 'public, max-age=31536000, immutable'
                    });
                    return res.end(buf);
                } catch (e) {
                    res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
                    return res.end('素材下载失败（可能是没有联网）');
                }
            }

            // 作品缩略图（首页作品墙用）
            const thumbMatch = pathname.match(/^\/thumb\/([A-Za-z0-9._-]+)\.png$/);
            if (thumbMatch) {
                const f = resolveWithin(getProjectsDir(), `/${thumbMatch[1]}/thumb.png`);
                if (await serveFile(res, f)) return;
                return notFound(res);
            }

            if (pathname === '/api/library') {
                const [builtin, user] = await Promise.all([
                    readBuiltinLibrary(builtinLibDir),
                    scanUserAssets(myAssetsDir)
                ]);
                return sendJson(res, {
                    sprites: [...builtin.sprites, ...user.sprites],
                    backdrops: [...builtin.backdrops, ...user.backdrops],
                    sounds: [...builtin.sounds, ...user.sounds]
                });
            }

            if (pathname.startsWith('/my-assets/')) {
                const f = resolveWithin(myAssetsDir, pathname.slice('/my-assets'.length));
                if (await serveFile(res, f)) return;
                return notFound(res);
            }

            for (const [prefix, dir, immutable] of mounts) {
                if (pathname.startsWith(prefix)) {
                    const f = resolveWithin(dir, pathname.slice(prefix.length - 1));
                    if (await serveFile(res, f, { immutable })) return;
                    return notFound(res);
                }
            }

            // 根目录直接映射到 renderer
            const f = resolveWithin(rendererDir, pathname);
            if (await serveFile(res, f)) return;
            return notFound(res);
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('500: ' + e.message);
        }
    });

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

module.exports = { createServer };
