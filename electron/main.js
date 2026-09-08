'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const { paths, ensureDirs } = require('./paths');
const { createServer } = require('./server');
const store = require('./store');
const updater = require('./updater');

let mainWindow = null;
let origin = null;
let flushing = false;
let allowClose = false;

const isSelfTest = process.env.KID_SELFTEST === '1';

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');

async function boot () {
    ensureDirs();
    const srv = await createServer({
        rendererDir: paths.rendererDir,
        guiDir: paths.guiDir,
        reactDir: paths.reactDir,
        reactDomDir: paths.reactDomDir,
        builtinLibDir: paths.builtinLibDir,
        myAssetsDir: paths.myAssetsDir,
        assetCacheDir: paths.assetCacheDir,
        getProjectsDir: () => paths.projectsDir
    });
    origin = srv.origin;

    mainWindow = new BrowserWindow({
        width: 1360,
        height: 860,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: '#f6f2ff',
        title: '小小创客',
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            spellcheck: false,
            backgroundThrottling: false
        }
    });

    // 素材库的缩略图在 scratch-gui 里是写死的 CDN 地址（不走 assetHost），
    // 统一重定向到本地缓存代理：这样缩略图也能命中缓存、离线可用。
    mainWindow.webContents.session.webRequest.onBeforeRequest(
        { urls: ['*://cdn.assets.scratch.mit.edu/internalapi/asset/*', '*://assets.scratch.mit.edu/internalapi/asset/*'] },
        (details, callback) => {
            const m = /\/internalapi\/asset\/([^/?#]+)/.exec(details.url);
            if (!m) return callback({});
            callback({ redirectURL: `${origin}/scratch-assets/internalapi/asset/${m[1]}/get/` });
        }
    );

    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', onWindowClose);

    // 外部链接一律用系统浏览器打开，不在 App 内跳走
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith(origin)) {
            e.preventDefault();
            if (/^https?:/.test(url)) shell.openExternal(url);
        }
    });

    buildMenu();
    await mainWindow.loadURL(`${origin}/index.html`);

    if (isSelfTest) {
        const { runSelfTest } = require('./selftest');
        await runSelfTest(mainWindow, origin);
        return;
    }
    updater.start();
}

// 关窗前先让编辑器把当前进度存盘
function onWindowClose (e) {
    if (allowClose || !mainWindow) return;
    e.preventDefault();
    if (flushing) return;
    flushing = true;
    const done = () => {
        flushing = false;
        allowClose = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    };
    const timer = setTimeout(done, 6000);
    ipcMain.once('app:flush-done', () => {
        clearTimeout(timer);
        done();
    });
    mainWindow.webContents.send('app:flush-request');
}

function buildMenu () {
    const template = [
        ...(process.platform === 'darwin' ? [{
            label: '小小创客',
            submenu: [
                { role: 'about', label: '关于 小小创客' },
                { label: '检查更新…', click: () => updater.checkForUpdates({ silent: false }) },
                { type: 'separator' },
                { role: 'hide', label: '隐藏' },
                { role: 'quit', label: '退出' }
            ]
        }] : []),
        {
            label: '作品',
            submenu: [
                {
                    label: '回到作品墙',
                    accelerator: 'CmdOrCtrl+Shift+H',
                    click: () => mainWindow && mainWindow.loadURL(`${origin}/index.html`)
                },
                {
                    label: '打开作品文件夹',
                    click: () => shell.openPath(paths.projectsDir)
                },
                { type: 'separator' },
                ...(process.platform === 'darwin' ? [] : [{ label: '检查更新…', click: () => updater.checkForUpdates({ silent: false }) }]),
                { role: 'close', label: '关闭窗口' }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' }
            ]
        },
        {
            label: '视图',
            submenu: [
                { role: 'reload', label: '重新加载' },
                { role: 'togglefullscreen', label: '全屏' },
                { role: 'resetZoom', label: '实际大小' },
                { role: 'zoomIn', label: '放大' },
                { role: 'zoomOut', label: '缩小' },
                { type: 'separator' },
                { role: 'toggleDevTools', label: '开发者工具' }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC ----------------------------------------------------------------
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
    try {
        return { ok: true, data: await fn(...args) };
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
});

handle('projects:list', () => store.list());
handle('projects:create', name => store.create(name));
handle('projects:read', id => store.read(id));
handle('projects:save', (id, buf, thumb) => store.save(id, buf, thumb));
handle('projects:rename', (id, name) => store.rename(id, name));
handle('projects:duplicate', id => store.duplicate(id));
handle('projects:remove', id => store.remove(id));
handle('projects:meta', id => store.readMeta(id));
handle('projects:listHistory', id => store.listHistory(id));
handle('projects:readHistory', (id, file) => store.readHistory(id, file));
handle('projects:openFolder', () => shell.openPath(paths.projectsDir));

handle('projects:importDialog', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择要导入的 Scratch 作品',
        filters: [{ name: 'Scratch 作品', extensions: ['sb3', 'sb2', 'sb'] }],
        properties: ['openFile', 'multiSelections']
    });
    if (r.canceled) return { canceled: true };
    const ids = [];
    for (const f of r.filePaths) ids.push((await store.importSb3(f)).id);
    return { canceled: false, ids };
});

handle('projects:exportDialog', async id => {
    const meta = await store.readMeta(id);
    const r = await dialog.showSaveDialog(mainWindow, {
        title: '导出作品',
        defaultPath: `${(meta && meta.name) || '作品'}.sb3`,
        filters: [{ name: 'Scratch 作品', extensions: ['sb3'] }]
    });
    if (r.canceled) return { canceled: true };
    await store.exportSb3(id, r.filePath);
    return { canceled: false, path: r.filePath };
});

handle('library:openMyAssetsFolder', () => shell.openPath(paths.myAssetsDir));

handle('library:addFilesDialog', async kind => {
    const cfg = {
        角色: { filters: [{ name: '图片', extensions: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp'] }] },
        背景: { filters: [{ name: '图片', extensions: ['svg', 'png', 'jpg', 'jpeg', 'gif', 'bmp'] }] },
        声音: { filters: [{ name: '声音', extensions: ['wav', 'mp3', 'ogg', 'm4a'] }] }
    }[kind];
    if (!cfg) throw new Error('未知的素材类型');
    const r = await dialog.showOpenDialog(mainWindow, {
        title: `添加到「我的素材 / ${kind}」`,
        filters: cfg.filters,
        properties: ['openFile', 'multiSelections']
    });
    if (r.canceled) return { canceled: true };
    const target = path.join(paths.myAssetsDir, kind);
    fs.mkdirSync(target, { recursive: true });
    let n = 0;
    for (const f of r.filePaths) {
        let dest = path.join(target, path.basename(f));
        let i = 1;
        while (fs.existsSync(dest)) {
            const ext = path.extname(f);
            dest = path.join(target, `${path.basename(f, ext)}-${i++}${ext}`);
        }
        fs.copyFileSync(f, dest);
        n++;
    }
    return { canceled: false, count: n };
});

handle('update:check', () => updater.checkForUpdates({ silent: false }));
handle('update:install', () => updater.installPending());
handle('update:state', () => updater.getState());

handle('app:info', () => ({
    origin,
    docsRoot: paths.docsRoot,
    projectsDir: paths.projectsDir,
    myAssetsDir: paths.myAssetsDir,
    version: app.getVersion(),
    platform: process.platform
}));

handle('app:toggleFullScreen', () => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
});

handle('app:confirm', async ({ title, message, detail, confirmText = '确定', cancelText = '取消', danger = false }) => {
    const r = await dialog.showMessageBox(mainWindow, {
        type: danger ? 'warning' : 'question',
        buttons: [confirmText, cancelText],
        defaultId: danger ? 1 : 0,
        cancelId: 1,
        title: title || '请确认',
        message: message || '',
        detail
    });
    return r.response === 0;
});

handle('app:message', async ({ title, message, detail, type = 'info' }) => {
    await dialog.showMessageBox(mainWindow, { type, buttons: ['好的'], title: title || '提示', message: message || '', detail });
    return true;
});

// ---- 生命周期 -----------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    app.whenReady().then(boot).catch(err => {
        dialog.showErrorBox('启动失败', String(err && err.stack || err));
        app.quit();
    });
    app.on('window-all-closed', () => app.quit());
}
