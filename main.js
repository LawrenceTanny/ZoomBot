const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, shell } = require('electron');
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
        setInterval(() => {
            if (botProcess === null) { 
                if (mainWindow) mainWindow.webContents.send('from-bot', '🔄 Auto-checking for updates (Bot is idle)...');
                autoUpdater.checkForUpdatesAndNotify();
            } else {
                console.log("Auto-update check skipped because bot is running. Will run again in 5 minutes."); 
            }
        }, 5 * 60 * 1000);
    });
}

// --- APP LIFECYCLE ---
app.whenReady().then(createWindow);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

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
   
    let count = 0;
    const intervalId = setInterval(() => {
        count++;
        if (count === 5) {
            clearInterval(intervalId);
            if(mainWindow) mainWindow.webContents.send('from-bot', '🎉 Update downloaded. Restarting in 5s...');
        }
        if (count === 1){
            if(mainWindow) mainWindow.webContents.send('from-bot', count + ' second until restart...');
        }else if(count < 5 && count > 1){
            if(mainWindow) mainWindow.webContents.send('from-bot', count + ' seconds until restart...');
        }

        
     }, 1000); 

    setTimeout(() => { autoUpdater.quitAndInstall(); }, 5000);

});

// --- BOT CONTROL ---
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
});

ipcMain.on('kill-bot', () => {
    if (botProcess) { botProcess.kill(); botProcess = null; }
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

// --- BUG REPORT LOGIC ---
ipcMain.on('trigger-bug-report', async () => {
    try {
        const reportDir = path.join(app.getPath('userData'), 'BugReports');
        if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir);

        // 1. Capture Screenshot
        const sources = await desktopCapturer.getSources({ 
            types: ['window', 'screen'], 
            thumbnailSize: { width: 1280, height: 720 } 
        });
        
        const screenshotPath = path.join(reportDir, `screenshot_${Date.now()}.png`);
        fs.writeFileSync(screenshotPath, sources[0].thumbnail.toPNG());

        // 2. Open Email
        const subject = encodeURIComponent(`[GenBot Bug Report] v${app.getVersion()}`);
        const body = encodeURIComponent(`Hi Lawrence,\n\nI encountered an error. I have attached the logs and screenshot found in the folder that just opened.\n\nDescription of what I was doing:\n[Write here]`);
        
        shell.openExternal(`mailto:lawrencedominiquetan1104@gmail.com?subject=${subject}&body=${body}`);
        
        // 3. Show the folder for the user to grab the screenshot
        shell.showItemInFolder(screenshotPath);
    } catch (err) {
        console.error("Bug Report Failed:", err);
    }
});