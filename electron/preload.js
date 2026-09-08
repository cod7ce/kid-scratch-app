'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('kid', {
    projects: {
        list: () => invoke('projects:list'),
        create: name => invoke('projects:create', name),
        read: id => invoke('projects:read', id),
        save: (id, arrayBuffer, thumb) => invoke('projects:save', id, arrayBuffer, thumb),
        rename: (id, name) => invoke('projects:rename', id, name),
        duplicate: id => invoke('projects:duplicate', id),
        remove: id => invoke('projects:remove', id),
        meta: id => invoke('projects:meta', id),
        listHistory: id => invoke('projects:listHistory', id),
        readHistory: (id, file) => invoke('projects:readHistory', id, file),
        importDialog: () => invoke('projects:importDialog'),
        exportDialog: id => invoke('projects:exportDialog', id),
        openFolder: () => invoke('projects:openFolder')
    },
    library: {
        openMyAssetsFolder: () => invoke('library:openMyAssetsFolder'),
        addFilesDialog: kind => invoke('library:addFilesDialog', kind)
    },
    update: {
        check: () => invoke('update:check'),
        install: () => invoke('update:install'),
        state: () => invoke('update:state'),
        onStatus: handler => ipcRenderer.on('update:status', (_e, s) => handler(s))
    },
    app: {
        info: () => invoke('app:info'),
        toggleFullScreen: () => invoke('app:toggleFullScreen'),
        confirm: opts => invoke('app:confirm', opts),
        message: opts => invoke('app:message', opts),
        // 主进程在关窗前会请求一次强制保存
        onFlushRequest: handler => {
            ipcRenderer.on('app:flush-request', async () => {
                let ok = true;
                try {
                    await handler();
                } catch (e) {
                    ok = false;
                }
                ipcRenderer.send('app:flush-done', ok);
            });
        }
    }
});
