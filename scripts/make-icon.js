'use strict';
// 用 Electron 把 HTML 渲染成 1024 图标，再转成 icns / ico 需要的尺寸
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');

const html = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
.sq{position:absolute;inset:64px;border-radius:230px;
    background:linear-gradient(145deg,#8b5cff 0%,#b45cff 45%,#ff6b9d 100%);
    box-shadow:inset 0 -40px 80px rgba(0,0,0,.12)}
svg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%)}
</style>
<div class="sq"></div>
<svg width="620" height="620" viewBox="0 0 120 120">
  <g stroke="#7a3f0c" stroke-width="4.5" stroke-linejoin="round">
    <path d="M28 46 L33 14 L57 32 Z" fill="#ffb35c"/><path d="M92 46 L87 14 L63 32 Z" fill="#ffb35c"/>
    <circle cx="60" cy="66" r="38" fill="#ffcb85"/>
  </g>
  <circle cx="46" cy="60" r="6.5" fill="#3b2412"/><circle cx="74" cy="60" r="6.5" fill="#3b2412"/>
  <circle cx="48.5" cy="57.5" r="2.2" fill="#fff"/><circle cx="76.5" cy="57.5" r="2.2" fill="#fff"/>
  <path d="M60 76 l-7 -7 h14 z" fill="#ff7aa2"/>
  <path d="M60 78 q-9 11 -17 4 M60 78 q9 11 17 4" stroke="#7a3f0c" stroke-width="3.8" fill="none" stroke-linecap="round"/>
  <g stroke="#7a3f0c" stroke-width="3.2" stroke-linecap="round"><path d="M16 62 h18 M16 76 h18 M104 62 h-18 M104 76 h-18"/></g>
  <g transform="translate(60 106)">
    <rect x="-34" y="-9" width="68" height="18" rx="9" fill="#4c97ff" stroke="#3373cc" stroke-width="3"/>
    <rect x="-14" y="-15" width="28" height="8" rx="4" fill="#4c97ff" stroke="#3373cc" stroke-width="3"/>
  </g>
</svg>`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1024, height: 1024, show: false, frame: false, transparent: true,
        backgroundColor: '#00000000', useContentSize: true,
        webPreferences: { offscreen: false }
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 600));
    const img = await win.webContents.capturePage();
    const png = img.resize({ width: 1024, height: 1024 }).toPNG();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'icon.png'), png);
    console.log('图标已生成', path.join(OUT, 'icon.png'), png.length, 'bytes');
    app.exit(0);
});
