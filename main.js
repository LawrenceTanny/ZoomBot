const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { fork } = require('child_process'); 
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

log.transports.file.level = "info";
autoUpdater.logger = log;

let mainWindow;
let botProcess = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        backgroundColor: '#121212',
        webPreferences: {
            nodeIntegration: false, 
            contextIsolation: true, 
            preload: path.join(__dirname, 'preload.js'),
            sandbox: false 
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('index.html');
    mainWindow.once('ready-to-show', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });
}

app.whenReady().then(createWindow);
autoUpdater.on('checking-for-update', () => {
    if(mainWindow) mainWindow.webContents.send('from-bot', '🔄 Checking for updates...');
});
autoUpdater.on('update-available', (info) => {
    if(mainWindow) mainWindow.webContents.send('from-bot', '⬇️ Update found! Downloading...');
});
autoUpdater.on('update-not-available', (info) => {
    if(mainWindow) mainWindow.webContents.send('from-bot', '✅ App is up to date.');
});
autoUpdater.on('error', (err) => {
    if(mainWindow) mainWindow.webContents.send('from-bot', '⚠️ Update Error: ' + err);
});
autoUpdater.on('update-downloaded', (info) => {
    if(mainWindow) mainWindow.webContents.send('from-bot', '🎉 Update downloaded. Restarting in 5s...');
    setTimeout(() => {
        autoUpdater.quitAndInstall();
    }, 5000);
});

ipcMain.on('run-bot', (event) => {
    if (botProcess) return;
    botProcess = fork(path.join(__dirname, 'server.js'), [], { 
        silent: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: 1 } 
    });

    if (botProcess.stdout) {
        botProcess.stdout.on('data', (data) => {
            if (mainWindow) mainWindow.webContents.send('from-bot', data.toString());
        });
    }

    if (botProcess.stderr) {
        botProcess.stderr.on('data', (data) => {
            if (mainWindow) mainWindow.webContents.send('from-bot', `⚠️ ERR: ${data.toString()}`);
        });
    }

    botProcess.on('close', (code) => {
        if (mainWindow) mainWindow.webContents.send('from-bot', `🛑 Bot stopped (Code: ${code})`);
        botProcess = null;
    });
    
    botProcess.on('error', (err) => {
        if (mainWindow) mainWindow.webContents.send('from-bot', `🔥 PROCESS ERROR: ${err.message}`);
    });
});

ipcMain.on('kill-bot', () => {
    if (botProcess) {
        botProcess.kill();
        botProcess = null;
    }
});

ipcMain.handle('save-log-file', async (event, logContent) => {
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export Bot Logs',
        defaultPath: path.join(app.getPath('documents'), `watchman_log_${Date.now()}.txt`),
        filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });

    if (filePath) {
        fs.writeFileSync(filePath, logContent);
        return filePath;
    }
    return null;
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});