'use strict';
// 自动更新：直接读 GitHub Releases（公开仓库，匿名即可），下载新版并原地替换 App。
// 没有用 electron-updater，因为它在 macOS 上依赖 Squirrel.Mac，
// 而 Squirrel.Mac 要求 App 有有效的 Developer ID 签名——这台机器上只有 Apple Development 证书。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn, execFile } = require('child_process');
const { app, dialog, shell, BrowserWindow } = require('electron');

const REPO = 'cod7ce/kid-scratch-app';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 小时
const FIRST_CHECK_DELAY = 20 * 1000;

let state = { status: 'idle' };
let busy = false;

function broadcast (patch) {
    state = Object.assign({}, state, patch);
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:status', state);
    }
}

// ---- 版本比较 ------------------------------------------------------------
function parseVersion (v) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
    if (!m) return null;
    return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || null };
}

function isNewer (candidate, current) {
    const a = parseVersion(candidate);
    const b = parseVersion(current);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i];
    }
    // 正式版 > 预发布版；两个预发布版按字典序
    if (a.pre === b.pre) return false;
    if (!a.pre) return true;
    if (!b.pre) return false;
    return a.pre > b.pre;
}

// ---- 查询最新版 ----------------------------------------------------------
function assetPattern () {
    if (process.platform === 'darwin') return new RegExp(`-mac-${process.arch}\\.zip$`);
    if (process.platform === 'win32') return /-setup\.exe$/;
    return null;
}

async function fetchLatest () {
    const resp = await fetch(API, {
        headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': `KidScratch/${app.getVersion()}`
        }
    });
    if (resp.status === 404) throw new Error('还没有发布过任何版本');
    if (!resp.ok) throw new Error(`GitHub 返回 ${resp.status}`);
    const release = await resp.json();
    if (release.draft) throw new Error('最新的发布还是草稿');

    const pattern = assetPattern();
    const asset = pattern && (release.assets || []).find(a => pattern.test(a.name));
    return {
        version: String(release.tag_name || '').replace(/^v/, ''),
        notes: release.body || '',
        publishedAt: release.published_at,
        pageUrl: release.html_url || RELEASES_PAGE,
        asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null
    };
}

/**
 * 检查更新。
 * @param {object} opts
 * @param {boolean} opts.silent 后台自动检查：没有更新时不打扰
 */
async function checkForUpdates (opts = {}) {
    const { silent = true } = opts;
    if (busy) return state;
    if (!app.isPackaged && !process.env.KID_UPDATE_DEV) {
        if (!silent) {
            await dialog.showMessageBox({
                type: 'info',
                buttons: ['好的'],
                title: '检查更新',
                message: '开发模式下不检查更新',
                detail: '打包后的 App 才会自动更新。'
            });
        }
        return state;
    }

    broadcast({ status: 'checking' });
    let latest;
    try {
        latest = await fetchLatest();
    } catch (err) {
        broadcast({ status: 'error', message: err.message });
        if (!silent) {
            await dialog.showMessageBox({
                type: 'warning',
                buttons: ['好的'],
                title: '检查更新失败',
                message: '没能连上 GitHub',
                detail: err.message
            });
        }
        return state;
    }

    if (!isNewer(latest.version, app.getVersion())) {
        broadcast({ status: 'latest', version: app.getVersion() });
        if (!silent) {
            await dialog.showMessageBox({
                type: 'info',
                buttons: ['好的'],
                title: '检查更新',
                message: '已经是最新版本啦',
                detail: `当前版本 v${app.getVersion()}`
            });
        }
        return state;
    }

    broadcast({
        status: 'available',
        version: latest.version,
        notes: latest.notes,
        pageUrl: latest.pageUrl,
        canAutoInstall: !!latest.asset,
        size: latest.asset ? latest.asset.size : 0
    });
    state.pending = latest;

    if (!silent) return promptInstall(latest);
    return state;
}

async function promptInstall (latest) {
    const canAuto = !!latest.asset;
    const buttons = canAuto ? ['现在更新', '打开下载页', '以后再说'] : ['打开下载页', '以后再说'];
    const r = await dialog.showMessageBox({
        type: 'info',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        title: '有新版本',
        message: `发现新版本 v${latest.version}`,
        detail: `${(latest.notes || '').slice(0, 600) || '包含一些改进。'}\n\n当前版本 v${app.getVersion()}`
    });
    if (canAuto && r.response === 0) return downloadAndInstall(latest);
    if ((canAuto && r.response === 1) || (!canAuto && r.response === 0)) shell.openExternal(latest.pageUrl);
    return state;
}

// ---- 下载并安装 ----------------------------------------------------------
async function download (url, destination, totalSize) {
    const resp = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': `KidScratch/${app.getVersion()}` }
    });
    if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
    const total = Number(resp.headers.get('content-length')) || totalSize || 0;

    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const out = fs.createWriteStream(destination);
    let received = 0;
    let lastReport = 0;

    const reader = resp.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (!out.write(Buffer.from(value))) {
            await new Promise(r => out.once('drain', r));
        }
        const now = Date.now();
        if (now - lastReport > 300) {
            lastReport = now;
            broadcast({ status: 'downloading', received, total, percent: total ? received / total : 0 });
        }
    }
    await new Promise((resolve, reject) => {
        out.end(err => (err ? reject(err) : resolve()));
    });
    broadcast({ status: 'downloading', received, total, percent: 1 });
    return received;
}

const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} 失败：${stderr || err.message}`));
        else resolve(stdout);
    });
});

async function downloadAndInstall (latest) {
    if (busy) return state;
    if (!latest || !latest.asset) throw new Error('这个版本没有可以自动安装的安装包');
    busy = true;
    const workDir = path.join(os.tmpdir(), 'kid-scratch-update');
    try {
        await fsp.rm(workDir, { recursive: true, force: true });
        const archive = path.join(workDir, latest.asset.name);
        const received = await download(latest.asset.url, archive, latest.asset.size);
        if (latest.asset.size && received !== latest.asset.size) {
            throw new Error(`下载的文件大小不对（${received} / ${latest.asset.size}）`);
        }

        broadcast({ status: 'installing' });
        if (process.platform === 'win32') {
            // Windows：交给 NSIS 安装程序，自己退出让它覆盖
            shell.openPath(archive);
            setTimeout(() => app.quit(), 800);
            return state;
        }
        await installMac(archive, workDir);
        return state;
    } catch (err) {
        busy = false;
        broadcast({ status: 'error', message: err.message });
        await dialog.showMessageBox({
            type: 'error',
            buttons: ['好的'],
            title: '更新失败',
            message: '更新没能完成',
            detail: `${err.message}\n\n可以到发布页手动下载：\n${RELEASES_PAGE}`
        });
        throw err;
    }
}

async function installMac (archive, workDir) {
    const extractDir = path.join(workDir, 'extracted');
    await fsp.mkdir(extractDir, { recursive: true });
    await run('/usr/bin/ditto', ['-x', '-k', archive, extractDir]);

    const entries = await fsp.readdir(extractDir);
    const appName = entries.find(n => n.endsWith('.app'));
    if (!appName) throw new Error('安装包里没找到 .app');
    const newApp = path.join(extractDir, appName);
    await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});

    // 当前 App 的 .app 路径：/…/小小创客.app/Contents/MacOS/小小创客
    const exe = app.getPath('exe');
    const idx = exe.indexOf('.app/');
    if (idx < 0) throw new Error('当前不是 .app 形式，无法原地更新');
    const currentApp = exe.slice(0, idx + 4);

    try {
        await fsp.access(path.dirname(currentApp), fs.constants.W_OK);
    } catch (e) {
        throw new Error(`没有权限写入 ${path.dirname(currentApp)}，请把 App 放到「应用程序」或个人目录下再更新`);
    }

    // 退出后再替换：脚本等本进程结束，换好包再把 App 拉起来
    const script = path.join(workDir, 'swap.sh');
    await fsp.writeFile(script, [
        '#!/bin/bash',
        'set -e',
        `PID=${process.pid}`,
        'for i in $(seq 1 100); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done',
        `NEW=${JSON.stringify(newApp)}`,
        `CUR=${JSON.stringify(currentApp)}`,
        'BACKUP="$CUR.old-$$"',
        'mv "$CUR" "$BACKUP"',
        'if /usr/bin/ditto "$NEW" "$CUR"; then',
        '  rm -rf "$BACKUP"',
        'else',
        '  rm -rf "$CUR"; mv "$BACKUP" "$CUR"',
        'fi',
        '/usr/bin/xattr -dr com.apple.quarantine "$CUR" || true',
        'sleep 0.5',
        '/usr/bin/open "$CUR"',
        `rm -rf ${JSON.stringify(workDir)} || true`
    ].join('\n'), { mode: 0o755 });

    broadcast({ status: 'restarting' });
    const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.exit(0), 600);
}

async function installPending () {
    if (!state.pending && !(await checkForUpdates({ silent: true })).pending) {
        throw new Error('当前没有可安装的更新');
    }
    return downloadAndInstall(state.pending);
}

function start () {
    if (!app.isPackaged && !process.env.KID_UPDATE_DEV) return;
    // 调试用：KID_UPDATE_FORCE=1 启动即检查，有新版就直接装（正常使用不需要）
    if (process.env.KID_UPDATE_FORCE === '1') {
        setTimeout(async () => {
            await checkForUpdates({ silent: true }).catch(() => {});
            if (state.pending) await downloadAndInstall(state.pending).catch(() => {});
            else console.log('[更新] 没有可用的新版本');
        }, 2000);
        return;
    }
    setTimeout(() => checkForUpdates({ silent: true }).catch(() => {}), FIRST_CHECK_DELAY);
    setInterval(() => checkForUpdates({ silent: true }).catch(() => {}), CHECK_INTERVAL);
}

module.exports = {
    start,
    checkForUpdates,
    installPending,
    getState: () => state,
    isNewer,
    RELEASES_PAGE
};
