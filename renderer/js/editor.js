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
            useMainThreadFetch(st);
        },
        onVmInit: instance => {
            vm = instance;
            window.vm = instance;
            instance.setCompatibilityMode(true);
        }
    }), target);
}

// scratch-storage 默认优先用 Web Worker 拉素材，但 scratch-gui 的预编译产物里
// 没有随包发出 fetch-worker 这个 chunk，new Worker(...) 直接 404。
// worker 起不来时它既不 reject 也不回退，storage.load 会永远 pending，
// 表现就是「素材库点了没反应、也没有任何报错」。这里把 worker 工具摘掉，只留主线程 fetch。
function useMainThreadFetch (st) {
    const helper = st && st.webHelper;
    if (!helper) return;
    for (const key of ['assetTool', 'projectTool']) {
        const tool = helper[key];
        if (!tool || !Array.isArray(tool.tools) || tool.tools.length < 2) continue;
        // FetchWorkerTool 是个代理壳，靠 inner 认出来；认不出就退而保留最后一个（FetchTool）
        const kept = tool.tools.filter(t => t && !t.inner);
        tool.tools = kept.length ? kept : [tool.tools[tool.tools.length - 1]];
    }
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

// ---------- 调试面板 ----------
// scratch-vm 的步进就是 runtime 上的一个 setInterval（_steppingInterval），
// 暂停 / 慢放 / 单步都是接管它。currentStepTime 只被响度、视频侦测等少数积木读取，改它是安全的。
const dbg = {
    open: false,
    paused: false,
    speed: 'normal',
    blockStep: false,
    recording: true,
    logs: [],
    steps: 0,
    lastFpsAt: 0,
    lastFpsSteps: 0
};
const DBG_SLOW = { normal: null, slow: 200, veryslow: 600 };
const DBG_MAX_LOGS = 200;

function dbgBaseInterval () {
    const RT = vm.runtime.constructor;
    return vm.runtime.compatibilityMode ? RT.THREAD_STEP_INTERVAL_COMPATIBILITY : RT.THREAD_STEP_INTERVAL;
}

// 按当前「暂停 / 速度」重建步进定时器
function dbgApplyRun () {
    const rt = vm.runtime;
    if (rt._steppingInterval) {
        clearInterval(rt._steppingInterval);
        rt._steppingInterval = null;
    }
    if (dbg.paused) return;
    const ms = DBG_SLOW[dbg.speed] || dbgBaseInterval();
    rt.currentStepTime = ms;
    rt._steppingInterval = setInterval(() => rt._step(), ms);
}

function dbgSetPaused (paused) {
    dbg.paused = paused;
    dbgApplyRun();
    $('dbg-pause').textContent = paused ? '▶ 继续' : '⏸ 暂停';
    $('dbg-step').disabled = !paused;
    dbgLog('run', paused ? '⏸ 暂停了' : '▶ 继续运行');
}

function dbgStepOnce () {
    if (!dbg.paused) return;
    // 逐块模式：先把这一帧里剩下的积木一块一块走完，走完了再跑下一帧
    if (dbg.blockStep && dbgAdvancePending()) return;
    vm.runtime._step();
    if (!dbg.blockStep) dbgLog('run', '⏭ 走了一步');
}

function dbgSetSpeed (speed) {
    dbg.speed = speed;
    for (const b of document.querySelectorAll('.dbg-sp')) {
        b.classList.toggle('active', b.dataset.speed === speed);
    }
    dbgApplyRun();
    dbgLog('run', `速度：${{ normal: '正常', slow: '慢', veryslow: '很慢' }[speed]}`);
}

// ---- 逐块高亮 ----------------------------------------------------------
// 说明：Scratch 的最小时间单位是「帧」，一帧里可能跑掉好几块积木，而且 sequencer 在
// 线程 YIELD 时是「下一帧重跑同一块」（那是「等待」积木的语义），没法用来做单块推进。
// 所以这里不去改执行，只记录每一帧真实执行过的积木顺序，再用 runtime.glowBlock
// 一块一块点亮 —— 顺序和实际执行完全一致，且对作品行为零影响。
let dbgPrimsPatched = false;
let dbgGlowing = null;
let dbgFrameBlocks = [];   // 当前这一帧执行过的积木（按顺序）
let dbgPending = [];       // 暂停逐块时，这一帧里还没走到的积木
let dbgPendingIdx = -1;
let dbgPlayTimers = [];

let dbgGlowEl = null;

function dbgClearGlow () {
    if (dbgGlowEl) {
        dbgGlowEl.classList.remove('kid-stepglow');
        dbgGlowEl = null;
    }
    dbgGlowing = null;
}

function dbgGlowId (id) {
    if (id === dbgGlowing) return;
    dbgClearGlow();
    // 只高亮当前编辑的角色里的积木：scratch-blocks 对工作区里不存在的 id 会直接抛错
    if (!id || !vm.editingTarget.blocks.getBlock(id)) return;
    dbgGlowing = id;
    // 积木 id 里有各种奇怪字符，不拼选择器，直接遍历比对最稳
    for (const node of document.querySelectorAll('g.blocklyDraggable[data-id]')) {
        if (node.getAttribute('data-id') === id) {
            node.classList.add('kid-stepglow');
            dbgGlowEl = node;
            break;
        }
    }
    // 手动单步时，如果高亮的积木在视口外（比如在自制积木的定义里），把代码区滚过去
    if (dbg.paused) dbgRevealBlock(id, dbgGlowEl);
}

function dbgRevealBlock (id, el) {
    try {
        const ws = window.Blockly && window.Blockly.getMainWorkspace && window.Blockly.getMainWorkspace();
        if (!ws || typeof ws.centerOnBlock !== 'function') return;
        const canvas = document.querySelector('.blocklySvg');
        if (el && canvas) {
            const r = el.getBoundingClientRect();
            const c = canvas.getBoundingClientRect();
            if (r.top >= c.top && r.bottom <= c.bottom && r.left >= c.left && r.right <= c.right) return;
        }
        ws.centerOnBlock(id);
    } catch (e) { /* 视图滚动失败无所谓 */ }
}

function dbgCancelPlay () {
    for (const t of dbgPlayTimers) clearTimeout(t);
    dbgPlayTimers = [];
}

function dbgOnFrameBlocks (list) {
    dbgCancelPlay();
    const ids = list.filter(b => b.target === vm.editingTarget && b.id).map(b => b.id);
    if (dbg.paused) {
        dbgPending = ids;
        dbgPendingIdx = -1;
        dbgAdvancePending();
        return;
    }
    if (!ids.length) { dbgClearGlow(); return; }
    // 连续运行时，把这一帧的积木均摊到这一帧的时长里依次点亮
    const span = DBG_SLOW[dbg.speed] || dbgBaseInterval();
    const each = Math.max(16, span / ids.length);
    ids.forEach((id, i) => {
        dbgPlayTimers.push(setTimeout(() => dbgGlowId(id), Math.round(i * each)));
    });
}

function dbgAdvancePending () {
    if (dbgPendingIdx + 1 >= dbgPending.length) return false;
    dbgPendingIdx++;
    dbgGlowId(dbgPending[dbgPendingIdx]);
    return true;
}

function dbgPatchPrimitives () {
    if (dbgPrimsPatched) return;
    dbgPrimsPatched = true;
    // 注意：execute.js 会把 runtime.getOpcodeFunction(opcode) 缓存进 BlockCached，
    // 所以必须在任何积木跑起来之前替换，替换完还要把已有缓存清一遍。
    const prims = vm.runtime._primitives;
    for (const opcode of Object.keys(prims)) {
        const orig = prims[opcode];
        if (typeof orig !== 'function') continue;
        prims[opcode] = function (args, util) {
            if (dbg.blockStep && util && util.thread) {
                dbgFrameBlocks.push({ id: util.thread.peekStack(), target: util.thread.target });
            }
            return orig.apply(this, arguments);
        };
    }
    for (const target of vm.runtime.targets) {
        if (target.blocks && target.blocks.resetCache) target.blocks.resetCache();
    }
    if (vm.runtime.flyoutBlocks && vm.runtime.flyoutBlocks.resetCache) vm.runtime.flyoutBlocks.resetCache();
}

function dbgSetBlockStep (on) {
    dbg.blockStep = on;
    dbgCancelPlay();
    dbgPending = [];
    dbgPendingIdx = -1;
    if (!on) dbgClearGlow();
    document.body.classList.toggle('kid-blockstep', on);
    $('dbg-blockstep').classList.toggle('active', on);
    $('dbg-step').textContent = on ? '⏭ 下一块' : '⏭ 走一步';
    $('dbg-tip').textContent = on
        ? '按真实执行顺序逐块点亮；只显示当前角色的积木'
        : '「等待 N 秒」走的是真实时间，不会跟着变慢';
    dbgLog('run', on ? '🔍 逐块高亮：开' : '🔍 逐块高亮：关');
}

function dbgLog (kind, text) {
    if (!dbg.recording && kind !== 'run') return;
    dbg.logs.push({ t: new Date(), kind, text });
    if (dbg.logs.length > DBG_MAX_LOGS) dbg.logs.shift();
    if (dbg.open) dbgRenderLog();
}

let dbgRenderQueued = false;
function dbgRenderLog () {
    if (dbgRenderQueued) return;
    dbgRenderQueued = true;
    requestAnimationFrame(() => {
        dbgRenderQueued = false;
        const box = $('dbg-log');
        if (!dbg.logs.length) {
            box.innerHTML = '<div class="dbg-empty">点绿旗跑一下，这里会显示发生了什么</div>';
            return;
        }
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        box.innerHTML = '';
        for (const it of dbg.logs) {
            const row = document.createElement('div');
            row.className = 'dbg-row';
            row.dataset.kind = it.kind;
            const time = document.createElement('span');
            time.className = 'dbg-time';
            time.textContent = it.t.toLocaleTimeString('zh-CN', { hour12: false });
            const msg = document.createElement('span');
            msg.className = 'dbg-msg';
            msg.textContent = it.text;
            row.append(time, msg);
            box.appendChild(row);
        }
        if (atBottom) box.scrollTop = box.scrollHeight;
    });
}

// 变量是直接赋值改的，没有事件可订阅，所以定时快照对比
let dbgVarSnapshot = new Map();
function dbgPollVariables () {
    if (!dbg.open || !dbg.recording || !vm) return;
    const seen = new Set();
    for (const target of vm.runtime.targets) {
        if (!target.isOriginal) continue;
        for (const v of Object.values(target.variables || {})) {
            if (v.type === 'list') continue;
            seen.add(v.id);
            const prev = dbgVarSnapshot.get(v.id);
            const now = String(v.value);
            if (prev === undefined) {
                dbgVarSnapshot.set(v.id, now);
            } else if (prev !== now) {
                dbgVarSnapshot.set(v.id, now);
                dbgLog('var', `${v.name}：${prev} → ${now}`);
            }
        }
    }
    for (const id of [...dbgVarSnapshot.keys()]) if (!seen.has(id)) dbgVarSnapshot.delete(id);
}

function dbgUpdateHud () {
    if (!dbg.open || !vm) return;
    const now = performance.now();
    if (dbg.lastFpsAt) {
        const fps = ((dbg.steps - dbg.lastFpsSteps) * 1000) / (now - dbg.lastFpsAt);
        $('dbg-fps').textContent = dbg.paused ? '暂停' : fps.toFixed(0);
    }
    dbg.lastFpsAt = now;
    dbg.lastFpsSteps = dbg.steps;
    $('dbg-threads').textContent = vm.runtime.threads.length;
    $('dbg-clones').textContent = vm.runtime.targets.filter(t => !t.isOriginal).length;
}

function initDebug () {
    const rt = vm.runtime;
    dbgPatchPrimitives();

    // 统计真实帧率
    const origStep = rt._step.bind(rt);
    rt._step = () => {
        if (dbg.blockStep) dbgFrameBlocks = [];
        origStep();
        dbg.steps++;
        if (dbg.blockStep) dbgOnFrameBlocks(dbgFrameBlocks);
    };

    // GUI 有时会自己再调一次 vm.start()，那样会用默认速度盖掉我们的设置
    rt.on('RUNTIME_STARTED', () => {
        if (dbg.paused || dbg.speed !== 'normal') setTimeout(dbgApplyRun, 0);
    });

    rt.on('SAY', (target, type, message) => {
        const text = String(message == null ? '' : message).trim();
        if (text) dbgLog('say', `${target.getName()} ${type === 'think' ? '想' : '说'}：${text}`);
    });
    vm.on('VISUAL_REPORT', report => dbgLog('value', `点了一下积木，结果是：${report.value}`));
    vm.on('PROJECT_START', () => dbgLog('run', '🏳️ 绿旗，开始！'));
    vm.on('PROJECT_RUN_STOP', () => { dbgLog('run', '⏹ 所有脚本跑完了'); dbgCancelPlay(); dbgClearGlow(); });

    const origError = console.error.bind(console);
    console.error = (...a) => {
        dbgLog('error', '出错了：' + a.map(x => (x && x.message) || String(x)).join(' ').slice(0, 200));
        origError(...a);
    };
    window.addEventListener('error', e => dbgLog('error', '出错了：' + e.message));

    setInterval(dbgPollVariables, 400);
    setInterval(dbgUpdateHud, 500);

    // 面板可以拖着走
    const panel = $('dbg');
    const head = $('dbg-head');
    let drag = null;
    head.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        const r = panel.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', e => {
        if (!drag) return;
        const x = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, e.clientX - drag.dx));
        const y = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, e.clientY - drag.dy));
        panel.style.left = `${x}px`;
        panel.style.top = `${y}px`;
        panel.style.bottom = 'auto';
    });
    head.addEventListener('pointerup', () => { drag = null; });
}

function dbgToggle (open) {
    dbg.open = open === undefined ? !dbg.open : open;
    $('dbg').hidden = !dbg.open;
    if (!dbg.open) { dbgCancelPlay(); dbgClearGlow(); }
    if (dbg.open) {
        dbgRenderLog();
        dbgUpdateHud();
    }
}

$('btn-debug').addEventListener('click', () => dbgToggle());
$('dbg-close').addEventListener('click', () => dbgToggle(false));
$('dbg-pause').addEventListener('click', () => dbgSetPaused(!dbg.paused));
$('dbg-step').addEventListener('click', dbgStepOnce);
$('dbg-blockstep').addEventListener('click', () => dbgSetBlockStep(!dbg.blockStep));
$('dbg-clear').addEventListener('click', () => { dbg.logs = []; dbgRenderLog(); });
$('dbg-record').addEventListener('change', e => { dbg.recording = e.target.checked; });
for (const b of document.querySelectorAll('.dbg-sp')) {
    b.addEventListener('click', () => dbgSetSpeed(b.dataset.speed));
}

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

window.__kidTest = { addSprite, addBackdrop, addSound, addCostumeToCurrent, save, getLibrary,
    debug: { state: dbg, toggle: dbgToggle, setPaused: dbgSetPaused, step: dbgStepOnce, setSpeed: dbgSetSpeed,
        log: dbgLog, setBlockStep: dbgSetBlockStep, glowing: () => dbgGlowing } };

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
    initDebug();
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
