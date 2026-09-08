'use strict';
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..');

// 用户可见的数据目录：~/文稿/小小创客
function docsRoot () {
    const custom = readSetting('dataDir');
    if (custom) return custom;
    return path.join(app.getPath('documents'), '小小创客');
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings () {
    try {
        return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch (e) {
        return {};
    }
}

function readSetting (key) {
    return readSettings()[key];
}

function writeSetting (key, value) {
    const s = readSettings();
    s[key] = value;
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

const paths = {
    ROOT,
    rendererDir: path.join(ROOT, 'renderer'),
    guiDir: path.join(ROOT, 'node_modules', 'scratch-gui', 'dist'),
    reactDir: path.join(ROOT, 'node_modules', 'react', 'umd'),
    reactDomDir: path.join(ROOT, 'node_modules', 'react-dom', 'umd'),
    builtinLibDir: path.join(ROOT, 'library'),
    get docsRoot () { return docsRoot(); },
    get projectsDir () { return path.join(docsRoot(), '我的作品'); },
    get myAssetsDir () { return path.join(docsRoot(), '我的素材'); },
    get trashDir () { return path.join(docsRoot(), '回收站'); },
    get assetCacheDir () { return path.join(app.getPath('userData'), 'scratch-asset-cache'); },
    readSetting,
    writeSetting
};

function ensureDirs () {
    for (const d of [paths.projectsDir, paths.myAssetsDir, paths.trashDir, paths.assetCacheDir]) {
        fs.mkdirSync(d, { recursive: true });
    }
    for (const sub of ['角色', '背景', '声音']) {
        fs.mkdirSync(path.join(paths.myAssetsDir, sub), { recursive: true });
    }
    const readme = path.join(paths.myAssetsDir, '把你的图片和声音放这里.txt');
    if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
            '把自己画的图片放进「角色」或「背景」文件夹（支持 svg / png / jpg / gif），\n' +
            '把录好的声音放进「声音」文件夹（支持 wav / mp3），\n' +
            '在 App 里点「我的素材」就能直接用啦！\n', 'utf8');
    }
}

module.exports = { paths, ensureDirs };
