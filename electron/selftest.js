'use strict';
// 自检：真实启动一次编辑器，验证 GUI 挂载、中文界面、素材添加、保存与读回
const { app } = require('electron');
const store = require('./store');

const log = (...a) => {
    console.log('[自检]', ...a);
    // 管道里的 stdout 是缓冲的，跑挂时看不到进度；给个文件出口方便实时 tail
    if (process.env.KID_LOG_FILE) {
        try {
            require('fs').appendFileSync(process.env.KID_LOG_FILE, `[自检] ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}\n`);
        } catch (e) { /* 忽略 */ }
    }
};

async function runSelfTest (win, origin) {
    const results = [];
    const check = (name, ok, extra) => {
        results.push({ name, ok, extra });
        log(ok ? '✅' : '❌', name, extra === undefined ? '' : JSON.stringify(extra));
    };

    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
        if (level >= 1) log('[渲染进程]', message, '@', String(sourceId).split('/').pop() + ':' + line);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => log('[加载失败]', code, desc, url));
    win.webContents.on('render-process-gone', (_e, d) => log('[渲染进程崩溃]', JSON.stringify(d)));

    try {
        const { id } = await store.create('自检作品');
        await win.loadURL(`${origin}/editor.html?id=${encodeURIComponent(id)}&locale=zh-cn`);

        const waitFor = async (expr, timeout = 60000, label = expr) => {
            const start = Date.now();
            for (;;) {
                const v = await win.webContents.executeJavaScript(expr).catch(() => null);
                if (v) return v;
                if (Date.now() - start > timeout) throw new Error('等待超时: ' + label);
                await new Promise(r => setTimeout(r, 300));
            }
        };

        const diagTimer = setInterval(async () => {
            const d = await win.webContents.executeJavaScript('window.__kidDiag ? window.__kidDiag() : null').catch(e => 'eval失败:' + e.message);
            log('诊断', JSON.stringify(d));
        }, 6000);
        try {
            await waitFor('window.__kidEditorReady === true || (window.__kidEditorError && {err: window.__kidEditorError})', 90000, '编辑器就绪');
        } finally {
            clearInterval(diagTimer);
        }
        const err = await win.webContents.executeJavaScript('window.__kidEditorError || null');
        check('编辑器启动', !err, err || undefined);
        if (err) throw new Error(err);

        const base = await win.webContents.executeJavaScript(`(() => ({
            hasVm: !!window.vm,
            targets: window.vm.runtime.targets.length,
            assetHost: window.vm.runtime.storage.assetHost,
            hasRenderer: !!window.vm.runtime.renderer,
            chinese: /代码|造型|声音/.test(document.body.innerText)
        }))()`);
        check('VM 已就绪', base.hasVm && base.targets > 0, base.targets);
        check('素材走本地代理', String(base.assetHost).includes('/scratch-assets'), base.assetHost);
        check('渲染器可用（WebGL）', base.hasRenderer);
        check('界面为中文', base.chinese);

        const { isNewer, pickRelease } = require('./updater');
        // 同一个 tag 有两个 Release、其中一个只有 blockmap 时，必须挑到带安装包的那个
        const zip = n => ({ name: n, state: 'uploaded', browser_download_url: 'https://x/' + n, size: 1 });
        const picked = pickRelease([
            { tag_name: 'v0.1.1', draft: false, prerelease: false, assets: [zip('KidScratch-0.1.1-mac-arm64.zip.blockmap')] },
            { tag_name: 'v0.1.1', draft: false, prerelease: false, assets: [zip(`KidScratch-0.1.1-mac-${process.arch}.zip`)] },
            { tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [zip(`KidScratch-0.1.0-mac-${process.arch}.zip`)] },
            { tag_name: 'v9.9.9', draft: true, prerelease: false, assets: [zip(`KidScratch-9.9.9-mac-${process.arch}.zip`)] }
        ]);
        check('能从重复/残缺的 Release 里挑对',
            !!picked && picked.version === '0.1.1' && !!picked.asset && picked.asset.name.endsWith(`-mac-${process.arch}.zip`),
            picked && { version: picked.version, asset: picked.asset && picked.asset.name });

        check('版本号比较正确',
            isNewer('1.0.1', '1.0.0') && isNewer('1.1.0', '1.0.9') && isNewer('2.0.0', '1.9.9') &&
            isNewer('1.0.0', '1.0.0-beta.1') && !isNewer('1.0.0', '1.0.0') && !isNewer('0.9.9', '1.0.0') &&
            !isNewer('1.0.0-beta.1', '1.0.0'));

        const libCount = await win.webContents.executeJavaScript(
            `fetch('/api/library').then(r => r.json()).then(l => ({s: l.sprites.length, b: l.backdrops.length, a: l.sounds.length}))`);
        check('内置素材库可读', libCount.s > 0 && libCount.b > 0 && libCount.a > 0, libCount);

        // 官方素材缓存代理（联网时才会成功，离线跳过）
        const cdn = await win.webContents.executeJavaScript(
            `fetch('/scratch-assets/internalapi/asset/cd21514d0531fdffb22204e0ec5ed84a.svg/get/').then(r => r.status).catch(() => 0)`);
        check('官方素材缓存代理', cdn === 200 || cdn === 504, { status: cdn, note: cdn === 504 ? '当前离线，属正常' : '' });

        const media = await win.webContents.executeJavaScript(
            `Promise.all(['/static/blocks-media/default/rotate-left.svg', '/gui/static/blocks-media/default/rotate-left.svg'].map(u => fetch(u).then(r => r.status)))`);
        check('积木图标资源可用', media.every(x => x === 200), media);
        check('启动遮罩已移除', await win.webContents.executeJavaScript('!document.getElementById("boot")'));

        // 官方素材库的缩略图走的是写死的 CDN 地址，必须被重定向到本地代理才能显示
        await win.webContents.executeJavaScript(`(() => {
            const btns = [...document.querySelectorAll('[class*="action-menu_main-button"]')];
            const target = btns[btns.length - 1];
            if (target) target.dispatchEvent(new MouseEvent('click', {bubbles: true}));
            return !!target;
        })()`);
        await new Promise(r => setTimeout(r, 6000));
        const thumbs = await win.webContents.executeJavaScript(`(() => {
            const imgs = [...document.querySelectorAll('[class*="library-item"] img')];
            return { count: imgs.length, broken: imgs.filter(i => i.complete && i.naturalWidth === 0).length };
        })()`);
        check('官方素材库缩略图正常', thumbs.count > 50 && thumbs.broken === 0, thumbs);

        // 真的从官方素材库选一个背景：storage.load 走的是另一条路，缩略图能显示不代表素材能加载
        const stageCostumesBefore = await win.webContents.executeJavaScript(
            'vm.runtime.getTargetForStage().getCostumes().length');
        await win.webContents.executeJavaScript(`(() => {
            const items = [...document.querySelectorAll('[class*="library-item_library-item"]')];
            if (!items.length) return false;
            items[0].dispatchEvent(new MouseEvent('click', {bubbles: true}));
            return true;
        })()`);
        await new Promise(r => setTimeout(r, 8000));
        const libraryPick = await win.webContents.executeJavaScript(`(() => {
            const stage = vm.runtime.getTargetForStage();
            const cs = stage.getCostumes();
            const last = cs[cs.length - 1] || {};
            return {
                count: cs.length,
                name: last.name,
                bytes: last.asset && last.asset.data ? last.asset.data.length : 0,
                size: last.size || null,
                modalClosed: document.querySelectorAll('[class*="library-item_library-item"]').length === 0
            };
        })()`);
        check('官方素材能真的加载进来',
            libraryPick.count === stageCostumesBefore + 1 && libraryPick.bytes > 1000, libraryPick);
        check('选完素材后弹窗自动关闭', libraryPick.modalClosed);

        // 扩展 worker：scratch-vm 写死了相对路径 './extension-worker.js'
        const workerStatus = await win.webContents.executeJavaScript(
            "fetch('/extension-worker.js').then(r => r.status).catch(() => 0)");
        check('扩展 worker 路径可用', workerStatus === 200, workerStatus);

        // 调试面板：暂停 / 单步 / 慢动作 / 日志
        const dbgResult = await win.webContents.executeJavaScript(`(async () => {
            const T = window.__kidTest.debug;
            const rt = window.vm.runtime;
            const out = {};
            T.toggle(true);

            T.setPaused(true);
            out.intervalCleared = rt._steppingInterval === null;
            const s0 = T.state.steps;
            await new Promise(r => setTimeout(r, 700));
            out.frozenFrames = T.state.steps - s0;

            T.step();
            out.afterStep = T.state.steps - s0;

            T.setPaused(false);
            T.setSpeed('veryslow');
            out.slowStepTime = rt.currentStepTime;
            const s1 = T.state.steps;
            await new Promise(r => setTimeout(r, 1500));
            out.slowFrames = T.state.steps - s1;

            T.setSpeed('normal');
            const s2 = T.state.steps;
            await new Promise(r => setTimeout(r, 700));
            out.normalFrames = T.state.steps - s2;
            out.running = rt._steppingInterval !== null;

            rt.emit('SAY', window.vm.editingTarget, 'say', '自检说的话');
            out.sayLogged = T.state.logs.some(l => l.kind === 'say' && l.text.includes('自检说的话'));

            T.toggle(false);
            return out;
        })()`);
        check('暂停能停住运行', dbgResult.intervalCleared && dbgResult.frozenFrames === 0, dbgResult);
        check('单步只走一帧', dbgResult.afterStep === 1, dbgResult.afterStep);
        check('慢动作确实变慢', dbgResult.slowStepTime === 600 && dbgResult.slowFrames >= 1 && dbgResult.slowFrames <= 4,
            { stepTime: dbgResult.slowStepTime, frames1500ms: dbgResult.slowFrames });
        check('恢复正常速度', dbgResult.running && dbgResult.normalFrames >= 10,
            { frames700ms: dbgResult.normalFrames });
        check('说的话进日志', dbgResult.sayLogged);

        // 逐块高亮：加一个带 6 块积木的角色，验证「暂停 + 下一块」能按真实执行顺序一块块走
        const stepResult = await win.webContents.executeJavaScript(`(async () => {
            const T = window.__kidTest.debug;
            const rt = window.vm.runtime;
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const N = 6;

            // 用标准 sb3 格式喂给 addSprite，让反序列化器自己建积木
            const blocks = {
                zt_hat: {opcode: 'event_whenflagclicked', next: 'zt_m0', parent: null,
                         inputs: {}, fields: {}, shadow: false, topLevel: true, x: 40, y: 40}
            };
            for (let i = 0; i < N; i++) {
                blocks['zt_m' + i] = {
                    opcode: 'motion_movesteps',
                    next: i === N - 1 ? null : 'zt_m' + (i + 1),
                    parent: i === 0 ? 'zt_hat' : 'zt_m' + (i - 1),
                    inputs: {STEPS: [1, [4, '1']]}, fields: {}, shadow: false, topLevel: false
                };
            }
            await window.vm.addSprite(JSON.stringify({
                name: '__自检逐块', isStage: false, x: 0, y: 0, visible: false, size: 100,
                direction: 90, rotationStyle: 'all around', draggable: false, currentCostume: 0,
                volume: 100, blocks, variables: {}, lists: {}, broadcasts: {}, sounds: [],
                costumes: [{name: 'c', assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
                            md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg', dataFormat: 'svg',
                            bitmapResolution: 1, rotationCenterX: 240, rotationCenterY: 180}]
            }));
            await sleep(400);
            const sprite = rt.targets[rt.targets.length - 1];
            window.vm.setEditingTarget(sprite.id);
            await sleep(200);
            const editingOk = window.vm.editingTarget === sprite;

            // 1) 逐块高亮不应该改变作品本身的运行速度
            T.setBlockStep(true);
            T.setPaused(false);
            const f0 = T.state.steps;
            rt.greenFlag();
            for (let i = 0; i < 100 && rt.threads.length; i++) await sleep(40);
            const framesToFinish = T.state.steps - f0;

            // 2) 暂停后，连点「下一块」应该按执行顺序逐块走
            rt.stopAll();
            T.setPaused(true);
            await sleep(200);
            rt.greenFlag();
            const seen = [];
            let domGlow = 0;
            for (let i = 0; i < 10; i++) {
                T.step();
                await sleep(50);
                const g = T.glowing();
                if (g && seen[seen.length - 1] !== g) seen.push(g);
                domGlow = Math.max(domGlow, document.querySelectorAll('.kid-stepglow').length);
            }

            T.setPaused(false);
            T.setBlockStep(false);
            rt.stopAll();
            window.vm.deleteSprite(sprite.id);
            await sleep(200);

            const want = [];
            for (let i = 0; i < N; i++) want.push('zt_m' + i);
            return {
                积木数: N,
                选中了测试角色: editingOk,
                跑完用了几帧: framesToFinish,
                逐块走过的积木: seen,
                顺序正确: seen.join(',') === want.join(','),
                代码区里描边的积木数: domGlow,
                高亮已清干净: T.glowing() === null
            };
        })()`);
        check('逐块高亮不影响作品运行速度', stepResult.选中了测试角色 && stepResult.跑完用了几帧 <= 2,
            { editing: stepResult.选中了测试角色, frames: stepResult.跑完用了几帧 });
        check('暂停后能一块一块往下走', stepResult.顺序正确, stepResult.逐块走过的积木);
        check('六块积木都被单独点亮', stepResult.逐块走过的积木.length === stepResult.积木数,
            stepResult.逐块走过的积木.length);
        check('代码区里同时只描边一块', stepResult.代码区里描边的积木数 === 1, stepResult.代码区里描边的积木数);
        check('关掉后高亮被清干净', stepResult.高亮已清干净);



        const add = await win.webContents.executeJavaScript(`(async () => {
            const before = window.vm.runtime.targets.length;
            const lib = await fetch('/api/library').then(r => r.json());
            await window.__kidTest.addSprite(lib.sprites[0]);
            await window.__kidTest.addBackdrop(lib.backdrops[0]);
            await window.__kidTest.addSound(lib.sounds[0]);
            const stage = window.vm.runtime.getTargetForStage();
            return {
                before,
                after: window.vm.runtime.targets.length,
                backdrops: stage.getCostumes().length,
                stageShowingNewBackdrop: stage.currentCostume === stage.getCostumes().length - 1,
                sounds: window.vm.editingTarget.getSounds().length,
                spriteCostume: window.vm.runtime.targets[window.vm.runtime.targets.length - 1].getCostumes().length
            };
        })()`);
        check('添加角色', add.after === add.before + 1, add);
        check('添加背景', add.backdrops >= 2, add.backdrops);
        check('背景自动切换到新加的', add.stageShowingNewBackdrop);
        check('添加声音', add.sounds >= 1, add.sounds);

        // 位图角色（我的素材里放的照片就是 PNG）走的是另一条路：先缩放再转 ImageBitmap，
        // 之前只测过内置的 SVG，这里补上
        const fs = require('fs');
        const { nativeImage } = require('electron');
        const { paths } = require('./paths');
        const TEST_ASSET = '__自检临时位图角色';
        const testPngPath = require('path').join(paths.myAssetsDir, '角色', `${TEST_ASSET}.png`);
        const bmpW = 60, bmpH = 40;
        const raw = Buffer.alloc(bmpW * bmpH * 4);
        for (let i = 0; i < bmpW * bmpH; i++) {
            raw[i * 4] = 0x40; raw[i * 4 + 1] = 0x90; raw[i * 4 + 2] = 0xf0; raw[i * 4 + 3] = 0xff;
        }
        fs.writeFileSync(testPngPath, nativeImage.createFromBitmap(raw, { width: bmpW, height: bmpH }).toPNG());
        try {
            const bmp = await win.webContents.executeJavaScript(`(async () => {
                const lib = await fetch('/api/library?t=' + Date.now()).then(r => r.json());
                const item = lib.sprites.find(s => s.name === ${JSON.stringify(TEST_ASSET)});
                if (!item) return { error: '素材库里没扫到刚放进去的 PNG' };
                const before = window.vm.runtime.targets.length;
                await window.__kidTest.addSprite(item);
                const t = window.vm.runtime.targets[window.vm.runtime.targets.length - 1];
                const c = t.getCostumes()[0] || {};
                return {
                    added: window.vm.runtime.targets.length - before,
                    name: t.getName(),
                    dataFormat: c.dataFormat,
                    size: c.size || null,
                    // scratch-vm 会把 bitmapResolution:1 的位图内部放大到 2 倍并把分辨率标成 2，
                    // 所以舞台上的实际尺寸是 size / bitmapResolution
                    resolution: c.bitmapResolution,
                    stageSize: c.size ? [c.size[0] / (c.bitmapResolution || 1), c.size[1] / (c.bitmapResolution || 1)] : null,
                    bytes: c.asset && c.asset.data ? c.asset.data.length : 0
                };
            })()`);
            check('照片类（PNG）角色也能加进来',
                !bmp.error && bmp.added === 1 && bmp.dataFormat === 'png' && bmp.bytes > 0 &&
                Array.isArray(bmp.stageSize) && bmp.stageSize[0] === bmpW && bmp.stageSize[1] === bmpH,
                bmp);
        } finally {
            fs.rmSync(testPngPath, { force: true });
        }


        // 先存一次，后面重开编辑器时才验证得了内容有没有完整落盘
        await win.webContents.executeJavaScript('window.__kidTest.save({force: true})');

        // 自动保存链路：改动 -> PROJECT_CHANGED -> 防抖 -> 落盘
        const before = (await store.readMeta(id)).modified;
        await new Promise(r => setTimeout(r, 1100));
        await win.webContents.executeJavaScript('window.vm.runtime.emitProjectChanged(); true;');
        await new Promise(r => setTimeout(r, 5000));
        const after = (await store.readMeta(id)).modified;
        check('改动后自动保存', after > before, { before, after });


        // 截图存到临时目录，方便人工确认界面
        const shotDir = process.env.KID_SHOT_DIR;
        if (shotDir) {
            const fs = require('fs');
            const path = require('path');
            fs.mkdirSync(shotDir, { recursive: true });
            const img1 = await win.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, 'editor.png'), img1.toPNG());
            await win.webContents.executeJavaScript(`(async () => {
                const T = window.__kidTest.debug;
                T.toggle(true);
                T.log('run', '🏳️ 绿旗，开始！');
                T.log('say', '小猫 说：你好，我要走 10 步啦');
                T.log('var', '分数：0 → 1');
                T.log('value', '点了一下积木，结果是：42');
                T.setSpeed('slow');
                return true;
            })()`);
            await new Promise(r => setTimeout(r, 900));
            const imgDbg = await win.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, 'debug.png'), imgDbg.toPNG());
            await win.webContents.executeJavaScript(
                "window.__kidTest.debug.setSpeed('normal'); window.__kidTest.debug.toggle(false); true;");
            await win.webContents.executeJavaScript("document.getElementById('btn-library').click(); true;");
            await new Promise(r => setTimeout(r, 1600));
            const img2 = await win.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, 'library.png'), img2.toPNG());
            await win.loadURL(`${origin}/index.html`);
            await new Promise(r => setTimeout(r, 1500));
            const img3 = await win.webContents.capturePage();
            fs.writeFileSync(path.join(shotDir, 'home.png'), img3.toPNG());
            log('截图已保存到', shotDir);
            // 回到编辑器，后面的保存测试还要用
            await win.loadURL(`${origin}/editor.html?id=${encodeURIComponent(id)}&locale=zh-cn`);
            await waitFor('window.__kidEditorReady === true', 90000, '编辑器重新就绪');
        }

        const saved = await win.webContents.executeJavaScript(
            'window.__kidTest.save({force: true}).then(ok => ok)');
        check('手动保存成功', saved === true);

        await new Promise(r => setTimeout(r, 600));
        const buf = await store.read(id);
        check('sb3 已写入磁盘', !!buf && buf.byteLength > 1000, buf ? buf.byteLength : 0);

        const reload = await win.webContents.executeJavaScript(`(async () => {
            const n1 = window.vm.runtime.targets.length;
            window.vm.clear();
            const r = await window.kid.projects.read(${JSON.stringify(id)});
            await window.vm.loadProject(r.data);
            return {before: n1, after: window.vm.runtime.targets.length};
        })()`);
        check('读回作品内容一致', reload.after === reload.before, reload);

        const meta = await store.readMeta(id);
        check('缩略图已生成', require('fs').existsSync(store.thumbPath(id)));
        check('元信息已更新', !!meta && meta.modified > 0);

        // 离开编辑器：scratch-gui 自带 beforeunload，Electron 默认会把跳转/关窗直接取消。
        // 必须用真实鼠标事件——只有真实输入才会产生 Chromium 要求的 sticky activation，
        // executeJavaScript 的 userGesture 不够，不带真实点击就复现不出来。
        const realClick = async selector => {
            const at = await win.webContents.executeJavaScript(`(() => {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()`);
            if (!at) throw new Error('找不到元素: ' + selector);
            win.focus();
            win.webContents.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        };

        await win.loadURL(`${origin}/editor.html?id=${encodeURIComponent(id)}&locale=zh-cn`);
        await waitFor('window.__kidEditorReady === true', 90000, '编辑器就绪(返回测试)');
        // scratch-gui 只在「项目有改动」时才挂 beforeunload，所以先制造一次改动
        await win.webContents.executeJavaScript('vm.runtime.emitProjectChanged(); true;');
        await new Promise(r => setTimeout(r, 1500));
        await realClick('#btn-home');
        let backHome = false;
        for (let i = 0; i < 8; i++) {
            await new Promise(r => setTimeout(r, 1500));
            if (await win.webContents.executeJavaScript('location.pathname').catch(() => '') === '/index.html') {
                backHome = true;
                break;
            }
        }
        check('真实点击也能返回作品墙（beforeunload 不拦）', backHome);

        // 关窗走同一套机制：先用真实点击给页面拿到 sticky activation，再关
        await win.loadURL(`${origin}/editor.html?id=${encodeURIComponent(id)}&locale=zh-cn`);
        await waitFor('window.__kidEditorReady === true', 90000, '编辑器就绪(关窗测试)');
        await win.webContents.executeJavaScript('vm.runtime.emitProjectChanged(); true;');
        await new Promise(r => setTimeout(r, 1500));
        await realClick('#project-name');
        await new Promise(r => setTimeout(r, 500));
        await win.webContents.executeJavaScript("document.getElementById('rename-overlay').hidden = true; true;");
        const closeStart = Date.now();
        let closed = false;
        win.once('closed', () => { closed = true; });
        win.close();
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (closed) break;
        }
        check('编辑器页能正常关窗', closed, closed ? { ms: Date.now() - closeStart } : '超过 12 秒未关闭');

        if (!process.env.KID_KEEP_TEST_PROJECT) await store.remove(id);
    } catch (e) {
        check('自检异常', false, e.message);
    }

    const failed = results.filter(r => !r.ok);
    log('----------------------------------------');
    log(`共 ${results.length} 项，通过 ${results.length - failed.length} 项，失败 ${failed.length} 项`);
    setTimeout(() => app.exit(failed.length ? 1 : 0), 400);
}

module.exports = { runSelfTest };
