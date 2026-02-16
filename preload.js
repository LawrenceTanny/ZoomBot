const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    startBot: () => ipcRenderer.send('run-bot'),
    stopBot: () => ipcRenderer.send('kill-bot'),
    receiveLogs: (callback) => ipcRenderer.on('from-bot', (event, value) => callback(value)),
    saveLog: (content) => ipcRenderer.invoke('save-log-file', content),
    sendBugReport: () => ipcRenderer.send('trigger-bug-report')
});