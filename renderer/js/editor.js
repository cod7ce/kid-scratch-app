'use strict';
/* 编辑器外壳：挂载 scratch-gui、接管作品的读写与自动保存、提供自定义素材库 */

const api = window.kid;
const params = new URLSearchParams(location.search);
const projectId = params.get('id');

const GUIModule = window.GUI;
const React = window.React;
const ReactDOM = window.ReactDOM;

let vm = null;
let storage = null;
let ready = false;
let dirty = false;
let saving = false;
let lastSavedAt = 0;
let projectName = '作品';

const AUTOSAVE_DEBOUNCE = 2500;   // 停手 2.5 秒就存
const AUTOSAVE_HEARTBEAT = 45000; // 一直在画也每 45 秒存一次

// ---------- 小工具 ----------
const $ = id => document.getElementById(id);
const toastEl = $('toast');
let toastTimer = null;

function toast (text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

async function call (promise) {
    const r = await promise;
    if (!r || r.ok === false) throw new Error((r && r.error) || '操作失败');
    return r.data;
}

function fail (title, err) {
    console.error(title, err);
    api.app.message({ title, message: (err && err.message) || String(err), type: 'error' });
}

function askName (defaultValue) {
    return new Promise(resolve => {
        const overlay = $('rename-overlay');
        const input = $('rename-input');
        input.value = defaultValue || '';
        overlay.hidden = false;
        input.focus();
        input.select();
        const close = v => {
            overlay.hidden = true;
            $('rename-ok').removeEventListener('click', onOk);
            $('rename-cancel').removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            resolve(v);
        };
        const onOk = () => close(input.value.trim() || null);
        const onCancel = () => close(null);
        const onKey = e => {
            if (e.key === 'Enter') onOk();
            else if (e.key === 'Escape') onCancel();
        };
        $('rename-ok').addEventListener('click', onOk);
        $('rename-cancel').addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}

// ---------- 保存状态 ----------
const badge = $('save-badge');
const saveText = $('save-text');

function setStatus (state, text) {
    badge.dataset.state = state;
    saveText.textContent = text;
}

function agoText () {
    if (!lastSavedAt) return '已自动保存';
    const s = Math.floor((Date.now() - lastSavedAt) / 1000);
    if (s < 10) return '已自动保存 · 刚刚';
    if (s < 60) return `已自动保存 · ${s} 秒前`;
    return `已自动保存 · ${Math.floor(s / 60)} 分钟前`;
}

setInterval(() => {
    if (badge.dataset.state === 'saved') setStatus('saved', agoText());
}, 10000);

// ---------- 自动保存 ----------
let debounceTimer = null;
let heartbeatTimer = null;

function markDirty () {
    if (!ready) return;
    dirty = true;
    setStatus('dirty', '正在创作…');
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => save(), AUTOSAVE_DEBOUNCE);
    if (!heartbeatTimer) {
        heartbeatTimer = setTimeout(() => {
            heartbeatTimer = null;
            if (dirty) save();
        }, AUTOSAVE_HEARTBEAT);
    }
}

function captureThumbnail () {
    try {
        const renderer = vm && vm.runtime && vm.runtime.renderer;
        if (!renderer || !renderer.canvas) return null;
        renderer.draw();
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 240;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(renderer.canvas, 0, 0, c.width, c.height);
        return c.toDataURL('image/png');
    } catch (e) {
        return null;
    }
}

async function save (opts = {}) {
    if (!ready || !projectId) return false;
    if (saving) return false;
    if (!dirty && !opts.force) return true;

    saving = true;
    dirty = false; // 序列化过程中的新改动会重新置脏，不会丢
    clearTimeout(debounceTimer);
    setStatus('saving', '保存中…');
    try {
        const blob = await vm.saveProjectSb3();
        const buffer = await blob.arrayBuffer();
        const thumb = captureThumbnail();
        await call(api.projects.save(projectId, buffer, thumb));
        lastSavedAt = Date.now();
        setStatus(dirty ? 'dirty' : 'saved', dirty ? '正在创作…' : agoText());
        return true;
    } catch (err) {
        dirty = true;
        setStatus('error', '保存失败，点这里重试');
        console.error('保存失败', err);
        return false;
    } finally {
        saving = false;
    }
}

// ---------- 挂载 scratch-gui ----------
function mountGui () {
    const WrappedGUI = GUIModule.AppStateHOC(GUIModule.default);
    const target = $('gui');
    if (GUIModule.setAppElement) GUIModule.setAppElement(target);

    ReactDOM.render(React.createElement(WrappedGUI, {
        // projectId 0 = scratch-gui 内置的默认作品（小猫），完全离线
        projectId: 0,
        // 这两个必须走 props：ProjectFetcherHOC 挂载时会用 props 覆盖 storage 上的设置
        assetHost: `${location.origin}/scratch-assets`,
        projectHost: `${location.origin}/scratch-projects`,
        canEditTitle: false,
        canSave: false,
        canCreateNew: false,
        canRemix: false,
        canShare: false,
        canCreateCopy: false,
        enableCommunity: false,
        showComingSoon: false,
        backpackVisible: false,
        isScratchDesktop: true,
        onStorageInit: st => {
            storage = st;
            // 所有官方素材都走本地服务器：命中缓存直接读盘，没有才联网下载并存下来
            st.setAssetHost(`${location.origin}/scratch-assets`);
            st.addOfficialScratchWebStores();
        },
        onVmInit: instance => {
            vm = instance;
            window.vm = instance;
            instance.setCompatibilityMode(true);
        }
    }), target);
}

function waitForVm () {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
            if (vm && vm.runtime && vm.editingTarget && vm.runtime.targets.length > 0) return resolve();
            if (Date.now() - started > 30000) return reject(new Error('编辑器加载超时'));
            setTimeout(tick, 80);
        };
        tick();
    });
}

// ---------- 作品读写 ----------
async function loadProject () {
    const meta = await call(api.projects.meta(projectId));
    projectName = (meta && meta.name) || '我的作品';
    $('project-name').textContent = projectName;
    document.title = `${projectName} · 小小创客`;

    const buffer = await call(api.projects.read(projectId));
    if (buffer && buffer.byteLength) {
        await vm.loadProject(buffer);
    }
}

// ---------- 素材库 ----------
let libraryCache = null;
let libKind = 'sprites';

async function getLibrary (force) {
    if (!libraryCache || force) {
        const resp = await fetch('/api/library');
        libraryCache = await resp.json();
    }
    return libraryCache;
}

function svgIntrinsicSize (text) {
    const num = v => {
        const m = /^\s*([\d.]+)/.exec(v || '');
        return m ? parseFloat(m[1]) : 0;
    };
    const w = num((/\bwidth\s*=\s*"([^"]+)"/.exec(text) || [])[1]);
    const h = num((/\bheight\s*=\s*"([^"]+)"/.exec(text) || [])[1]);
    if (w && h) return { width: w, height: h };
    const vb = (/\bviewBox\s*=\s*"([^"]+)"/.exec(text) || [])[1];
    if (vb) {
        const p = vb.trim().split(/[\s,]+/).map(Number);
        if (p.length === 4 && p[2] && p[3]) return { width: p[2], height: p[3] };
    }
    return { width: 100, height: 100 };
}

function loadImage (url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('图片读取失败'));
        img.src = url;
    });
}

// 位图统一转成 png，太大的自动缩到舞台尺寸以内
async function normalizeBitmap (url) {
    const img = await loadImage(url);
    const scale = Math.min(1, 480 / (img.naturalWidth || 1), 360 / (img.naturalHeight || 1));
    const w = Math.max(1, Math.round((img.naturalWidth || 100) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 100) * scale));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

function storeAsset (assetType, dataFormat, bytes) {
    const asset = storage.createAsset(assetType, dataFormat, bytes, null, true);
    // 同时塞进内置缓存，这样后面按 md5ext 反查（addSprite 的反序列化路径）也能找到
    try {
        storage.builtinHelper._store(assetType, dataFormat, bytes, asset.assetId);
    } catch (e) {
        try { storage.cache(assetType, dataFormat, bytes, asset.assetId); } catch (e2) { /* 忽略 */ }
    }
    return asset;
}

function unusedName (name, existing) {
    if (!existing.includes(name)) return name;
    let i = 2;
    while (existing.includes(`${name}${i}`)) i++;
    return `${name}${i}`;
}

async function buildCostume (item) {
    const resp = await fetch(item.url);
    if (!resp.ok) throw new Error('素材读取失败');
    const isSvg = item.ext === 'svg';
    let bytes;
    let dataFormat;
    let assetType;
    let width;
    let height;

    if (isSvg) {
        const text = await resp.text();
        bytes = new TextEncoder().encode(text);
        dataFormat = storage.DataFormat.SVG;
        assetType = storage.AssetType.ImageVector;
        ({ width, height } = svgIntrinsicSize(text));
    } else {
        const norm = await normalizeBitmap(item.url);
        bytes = norm.bytes;
        width = norm.width;
        height = norm.height;
        dataFormat = storage.DataFormat.PNG;
        assetType = storage.AssetType.ImageBitmap;
    }

    const asset = storeAsset(assetType, dataFormat, bytes);
    const md5ext = `${asset.assetId}.${dataFormat}`;
    return {
        asset,
        md5ext,
        costume: {
            name: item.name,
            bitmapResolution: 1,
            dataFormat,
            assetId: asset.assetId,
            md5ext,
            rotationCenterX: width / 2,
            rotationCenterY: height / 2
        }
    };
}

async function addSprite (item) {
    const { costume } = await buildCostume(item);
    const names = vm.runtime.targets.filter(t => !t.isStage).map(t => t.getName());
    const sprite = {
        name: unusedName(item.name, names),
        isStage: false,
        x: 0,
        y: 0,
        visible: true,
        size: 100,
        direction: 90,
        rotationStyle: 'all around',
        draggable: false,
        currentCostume: 0,
        volume: 100,
        blocks: {},
        variables: {},
        lists: {},
        broadcasts: {},
        costumes: [costume],
        sounds: []
    };
    await vm.addSprite(JSON.stringify(sprite));
}

async function addBackdrop (item) {
    const { costume, asset } = await buildCostume(item);
    await vm.addBackdrop(costume.md5ext, Object.assign({}, costume, { asset }));
    // 选中刚加进来的背景，孩子点一下就能立刻看到效果
    const stage = vm.runtime.getTargetForStage();
    if (stage) {
        stage.setCostume(stage.getCostumes().length - 1);
        vm.emitTargetsUpdate();
    }
    vm.runtime.requestRedraw();
}

async function addCostumeToCurrent (item) {
    const { costume, asset } = await buildCostume(item);
    await vm.addCostume(costume.md5ext, Object.assign({}, costume, { asset }));
}

async function addSound (item) {
    const resp = await fetch(item.url);
    if (!resp.ok) throw new Error('声音读取失败');
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const dataFormat = item.ext === 'mp3' ? storage.DataFormat.MP3 : storage.DataFormat.WAV;
    const asset = storeAsset(storage.AssetType.Sound, dataFormat, bytes);
    const names = (vm.editingTarget.getSounds() || []).map(s => s.name);
    await vm.addSound({
        name: unusedName(item.name, names),
        dataFormat,
        format: '',
        md5: `${asset.assetId}.${dataFormat}`,
        assetId: asset.assetId,
        asset
    });
}

function renderLibrary (list) {
    const body = $('lib-body');
    body.innerHTML = '';
    const keyword = $('lib-search').value.trim().toLowerCase();
    const items = list.filter(it => !keyword || it.name.toLowerCase().includes(keyword));

    if (!items.length) {
        const e = document.createElement('div');
        e.className = 'lib-empty';
        e.textContent = keyword ? '没找到这个素材～' : '这里还是空的，点右上角「＋ 加素材」放点东西进来吧！';
        body.appendChild(e);
        return;
    }

    for (const item of items) {
        const el = document.createElement('button');
        el.className = 'lib-item';
        const isSound = libKind === 'sounds';
        el.innerHTML = `
            <div class="pic">${isSound ? '<span class="sound">🔊</span>' : `<img src="${item.url}" alt="" loading="lazy">`}</div>
            <div class="nm"></div>
            <div class="badge">${item.source === 'builtin' ? '内置' : '我加的'}</div>`;
        el.querySelector('.nm').textContent = item.name;
        el.addEventListener('click', async () => {
            el.disabled = true;
            try {
                if (libKind === 'sprites') await addSprite(item);
                else if (libKind === 'backdrops') await addBackdrop(item);
                else await addSound(item);
                markDirty();
                toast(`已添加「${item.name}」`);
                $('library-overlay').hidden = true;
            } catch (err) {
                fail('添加失败', err);
            } finally {
                el.disabled = false;
            }
        });
        body.appendChild(el);
    }
}

async function openLibrary (force) {
    $('library-overlay').hidden = false;
    const lib = await getLibrary(force);
    renderLibrary(lib[libKind] || []);
}

// ---------- 历史版本 ----------
async function openHistory () {
    $('history-overlay').hidden = false;
    const list = $('history-list');
    list.innerHTML = '加载中…';
    try {
        const items = await call(api.projects.listHistory(projectId));
        list.innerHTML = '';
        if (!items.length) {
            list.innerHTML = '<div class="hint">还没有历史版本，多创作一会儿就有啦。</div>';
            return;
        }
        for (const it of items) {
            const row = document.createElement('div');
            row.className = 'history-row';
            row.innerHTML = `<span>🕘</span><span class="grow">${new Date(it.time).toLocaleString('zh-CN')}</span>
                <button>恢复这个</button>`;
            row.querySelector('button').addEventListener('click', async () => {
                const yes = await call(api.app.confirm({
                    title: '恢复历史版本',
                    message: '要把作品换成这个旧版本吗？',
                    detail: '当前进度会先自动存一份，之后也能再换回来。',
                    confirmText: '恢复'
                }));
                if (!yes) return;
                try {
                    await save({ force: true });
                    const buf = await call(api.projects.readHistory(projectId, it.file));
                    await vm.loadProject(buf);
                    markDirty();
                    await save({ force: true });
                    $('history-overlay').hidden = true;
                    toast('已经恢复啦');
                } catch (err) {
                    fail('恢复失败', err);
                }
            });
            list.appendChild(row);
        }
    } catch (err) {
        list.textContent = '读取失败：' + err.message;
    }
}

// ---------- 顶栏交互 ----------
async function goHome () {
    await save({ force: true });
    location.href = '/index.html';
}

$('btn-home').addEventListener('click', goHome);
$('btn-save').addEventListener('click', async () => {
    const ok = await save({ force: true });
    toast(ok ? '保存好啦！' : '保存失败了，再试一次？');
});
$('btn-fullscreen').addEventListener('click', () => api.app.toggleFullScreen());
$('btn-library').addEventListener('click', () => openLibrary());
$('btn-history').addEventListener('click', openHistory);
badge.addEventListener('click', () => { if (badge.dataset.state === 'error') save({ force: true }); });

$('btn-rename').addEventListener('click', async () => {
    const name = await askName(projectName);
    if (!name) return;
    try {
        await call(api.projects.rename(projectId, name));
        projectName = name;
        $('project-name').textContent = name;
        document.title = `${name} · 小小创客`;
        toast('改好啦！');
    } catch (err) {
        fail('改名失败', err);
    }
});

$('lib-close').addEventListener('click', () => { $('library-overlay').hidden = true; });
$('library-overlay').addEventListener('click', e => {
    if (e.target === $('library-overlay')) $('library-overlay').hidden = true;
});
$('history-close').addEventListener('click', () => { $('history-overlay').hidden = true; });
$('lib-search').addEventListener('input', async () => renderLibrary((await getLibrary())[libKind] || []));
$('lib-open-folder').addEventListener('click', () => api.library.openMyAssetsFolder());
$('lib-add').addEventListener('click', async () => {
    const kindName = { sprites: '角色', backdrops: '背景', sounds: '声音' }[libKind];
    try {
        const r = await call(api.library.addFilesDialog(kindName));
        if (r.canceled) return;
        toast(`加了 ${r.count} 个素材`);
        const lib = await getLibrary(true);
        renderLibrary(lib[libKind] || []);
    } catch (err) {
        fail('添加素材失败', err);
    }
});

for (const tab of document.querySelectorAll('.lib-tab')) {
    tab.addEventListener('click', async () => {
        document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        libKind = tab.dataset.kind;
        renderLibrary((await getLibrary())[libKind] || []);
    });
}

document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save({ force: true }).then(ok => toast(ok ? '保存好啦！' : '保存失败'));
    }
    if (e.key === 'Escape') {
        $('library-overlay').hidden = true;
        $('history-overlay').hidden = true;
    }
});

// 关窗前主进程会来要一次强制保存
api.app.onFlushRequest(async () => { await save({ force: true }); });

// 供自检脚本调用
window.__kidDiag = () => ({
    vm: !!vm,
    storage: !!storage,
    targets: vm && vm.runtime ? vm.runtime.targets.length : -1,
    editing: !!(vm && vm.editingTarget),
    guiExports: Object.keys(window.GUI || {}),
    reactOk: !!(window.React && window.ReactDOM),
    guiChildren: document.getElementById('gui').children.length
});

window.__kidTest = { addSprite, addBackdrop, addSound, addCostumeToCurrent, save, getLibrary };

// ---------- 启动 ----------
(async () => {
    if (!projectId) {
        location.replace('/index.html');
        return;
    }
    mountGui();
    await waitForVm();
    await loadProject();

    // 先让 GUI 把加载后的工作区渲染完，再开始盯改动
    await new Promise(r => setTimeout(r, 400));
    ready = true;
    vm.on('PROJECT_CHANGED', markDirty);
    setStatus('saved', '已自动保存');
    lastSavedAt = Date.now();

    // 新作品先落一次盘，作品墙上立刻能看到缩略图
    const existing = await call(api.projects.read(projectId));
    if (!existing || !existing.byteLength) await save({ force: true });

    const boot = $('boot');
    boot.classList.add('hide');
    await new Promise(r => setTimeout(r, 420));
    boot.remove();
    window.__kidEditorReady = true;
})().catch(err => {
    $('boot').innerHTML = `<div class="boot-cat">😿</div><div class="boot-text">编辑器没能打开：${err.message}</div>`;
    window.__kidEditorError = err.message;
    console.error(err);
});
