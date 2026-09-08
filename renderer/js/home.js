'use strict';
const api = window.kid;
const grid = document.getElementById('grid');
const toastEl = document.getElementById('toast');

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

function timeAgo (ts) {
    if (!ts) return '还没保存过';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚保存';
    if (min < 60) return `${min} 分钟前`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时前`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day} 天前`;
    return new Date(ts).toLocaleDateString('zh-CN');
}

const EMOJI = ['🐱', '🚀', '🦕', '🌈', '⭐️', '🎈', '🍎', '🤖', '🦄', '⚽️', '🍦', '🐶'];

// ---- 输入对话框 ----------------------------------------------------------
const renameOverlay = document.getElementById('rename-overlay');
const renameInput = document.getElementById('rename-input');
const renameTitle = document.getElementById('rename-title');

function askName (title, defaultValue) {
    return new Promise(resolve => {
        renameTitle.textContent = title;
        renameInput.value = defaultValue || '';
        renameOverlay.hidden = false;
        renameInput.focus();
        renameInput.select();

        const close = value => {
            renameOverlay.hidden = true;
            document.removeEventListener('keydown', onKey);
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            resolve(value);
        };
        const onOk = () => close(renameInput.value.trim() || null);
        const onCancel = () => close(null);
        const onKey = e => {
            if (e.key === 'Enter') onOk();
            if (e.key === 'Escape') onCancel();
        };
        const okBtn = document.getElementById('rename-ok');
        const cancelBtn = document.getElementById('rename-cancel');
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
    });
}

// ---- 作品墙 --------------------------------------------------------------
function openProject (id) {
    location.href = `/editor.html?id=${encodeURIComponent(id)}&locale=zh-cn`;
}

function cardTemplate (p, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;
    card.innerHTML = `
        <div class="thumb">${p.hasThumb
            ? `<img src="/thumb/${p.id}.png?t=${p.modified}" alt="">`
            : `<div class="placeholder">${EMOJI[index % EMOJI.length]}</div>`}</div>
        <div class="card-body">
            <p class="card-title"></p>
            <div class="card-meta">${timeAgo(p.modified)}${p.size ? ` · ${Math.max(1, Math.round(p.size / 1024))} KB` : ''}</div>
        </div>
        <div class="card-tools">
            <button class="tool" data-act="rename" title="改名字">✏️</button>
            <button class="tool" data-act="duplicate" title="复制一份">📄</button>
            <button class="tool" data-act="export" title="导出 sb3">📤</button>
            <button class="tool" data-act="delete" title="删除">🗑️</button>
        </div>`;
    card.querySelector('.card-title').textContent = p.name;

    card.addEventListener('click', e => {
        const btn = e.target.closest('.tool');
        if (btn) {
            e.stopPropagation();
            handleTool(btn.dataset.act, p);
            return;
        }
        openProject(p.id);
    });
    card.addEventListener('keydown', e => {
        if (e.key === 'Enter') openProject(p.id);
    });
    return card;
}

async function handleTool (act, p) {
    try {
        if (act === 'rename') {
            const name = await askName('给作品换个名字', p.name);
            if (!name) return;
            await call(api.projects.rename(p.id, name));
            toast('改好啦！');
        } else if (act === 'duplicate') {
            await call(api.projects.duplicate(p.id));
            toast('已经复制了一份');
        } else if (act === 'export') {
            const r = await call(api.projects.exportDialog(p.id));
            if (!r.canceled) toast('导出成功');
            return;
        } else if (act === 'delete') {
            const yes = await call(api.app.confirm({
                title: '删除作品',
                message: `确定要删除「${p.name}」吗？`,
                detail: '别担心，它会被放进「回收站」文件夹，还能找回来。',
                confirmText: '删掉它',
                danger: true
            }));
            if (!yes) return;
            await call(api.projects.remove(p.id));
            toast('已放进回收站');
        }
        await render();
    } catch (err) {
        api.app.message({ title: '出错了', message: err.message, type: 'error' });
    }
}

async function render () {
    const projects = await call(api.projects.list());
    grid.innerHTML = '';

    const newCard = document.createElement('div');
    newCard.className = 'card card-new';
    newCard.innerHTML = '<div class="plus">＋</div><div>新建作品</div><small>从一只小猫开始</small>';
    newCard.addEventListener('click', createProject);
    grid.appendChild(newCard);

    projects.forEach((p, i) => grid.appendChild(cardTemplate(p, i)));

    if (!projects.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = '还没有作品哦，点左边的「＋ 新建作品」开始第一个吧！';
        grid.appendChild(empty);
    }
}

async function createProject () {
    const name = await askName('给新作品起个名字', '我的新作品');
    if (!name) return;
    try {
        const { id } = await call(api.projects.create(name));
        openProject(id);
    } catch (err) {
        api.app.message({ title: '出错了', message: err.message, type: 'error' });
    }
}

document.getElementById('btn-import').addEventListener('click', async () => {
    try {
        const r = await call(api.projects.importDialog());
        if (r.canceled) return;
        toast(`导入了 ${r.ids.length} 个作品`);
        await render();
    } catch (err) {
        api.app.message({ title: '导入失败', message: err.message, type: 'error' });
    }
});

document.getElementById('btn-folder').addEventListener('click', () => api.projects.openFolder());
document.getElementById('btn-assets').addEventListener('click', () => api.library.openMyAssetsFolder());

(async () => {
    const info = await call(api.app.info());
    const footer = document.getElementById('footer-note');
    footer.innerHTML =
        `作品保存在 <code>${info.projectsDir}</code>　·　自定义素材放在 <code>${info.myAssetsDir}</code>` +
        `　·　v${info.version} <span class="footer-link" id="check-update">检查更新</span>`;
    document.getElementById('check-update').addEventListener('click', () => api.update.check());
    await render();
})().catch(err => {
    document.getElementById('footer-note').textContent = '加载失败：' + err.message;
});

// ---- 自动更新提示 --------------------------------------------------------
const uc = {
    card: document.getElementById('update-card'),
    title: document.getElementById('uc-title'),
    sub: document.getElementById('uc-sub'),
    bar: document.getElementById('uc-bar'),
    fill: document.getElementById('uc-bar-fill'),
    action: document.getElementById('uc-action'),
    dismiss: document.getElementById('uc-dismiss')
};

let dismissedVersion = null;
try {
    dismissedVersion = localStorage.getItem('kid.update.dismissed');
} catch (e) { /* 无痕模式等场景，忽略 */ }

const fmtMB = n => `${(n / 1048576).toFixed(0)} MB`;

function renderUpdate (s) {
    if (!s) return;
    if (s.status === 'available') {
        if (dismissedVersion === s.version) return;
        uc.title.textContent = `有新版本 v${s.version}`;
        uc.sub.textContent = s.canAutoInstall
            ? `点「更新」自动下载安装${s.size ? `（约 ${fmtMB(s.size)}）` : ''}`
            : '这个版本需要手动下载';
        uc.bar.hidden = true;
        uc.action.hidden = false;
        uc.action.disabled = false;
        uc.action.textContent = '更新';
        uc.dismiss.hidden = false;
        uc.card.hidden = false;
    } else if (s.status === 'downloading') {
        uc.card.hidden = false;
        uc.title.textContent = '正在下载新版本…';
        uc.sub.textContent = s.total ? `${fmtMB(s.received)} / ${fmtMB(s.total)}` : fmtMB(s.received);
        uc.bar.hidden = false;
        uc.fill.style.width = `${Math.round((s.percent || 0) * 100)}%`;
        uc.action.disabled = true;
        uc.action.textContent = '下载中';
        uc.dismiss.hidden = true;
    } else if (s.status === 'installing' || s.status === 'restarting') {
        uc.card.hidden = false;
        uc.title.textContent = '正在安装…';
        uc.sub.textContent = '装好会自动重新打开，别关电脑哦';
        uc.fill.style.width = '100%';
        uc.action.disabled = true;
    } else if (s.status === 'error') {
        uc.card.hidden = false;
        uc.title.textContent = '更新没成功';
        uc.sub.textContent = s.message || '稍后再试试';
        uc.bar.hidden = true;
        uc.action.disabled = false;
        uc.action.textContent = '重试';
        uc.dismiss.hidden = false;
    }
}

uc.action.addEventListener('click', async () => {
    uc.action.disabled = true;
    try {
        await call(api.update.install());
    } catch (err) {
        renderUpdate({ status: 'error', message: err.message });
    }
});

uc.dismiss.addEventListener('click', () => {
    const m = /v([\d.]+)/.exec(uc.title.textContent || '');
    if (m) {
        dismissedVersion = m[1];
        try { localStorage.setItem('kid.update.dismissed', m[1]); } catch (e) { /* 忽略 */ }
    }
    uc.card.hidden = true;
});

api.update.onStatus(renderUpdate);
api.update.state().then(r => r && r.ok && renderUpdate(r.data)).catch(() => {});
