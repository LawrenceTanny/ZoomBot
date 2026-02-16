console.time("Startup"); 
console.log("DEBUG: 1. Script starting...");

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { google } = require('googleapis');
const querystring = require('querystring');

// --- ⚙️ EXTERNAL CONFIG SETUP ---
const appName = 'GenBot';
const writableFolder = process.platform === 'win32' 
    ? path.join(process.env.APPDATA, appName) 
    : path.join(os.homedir(), '.config', appName); 

if (!fs.existsSync(writableFolder)) fs.mkdirSync(writableFolder, { recursive: true });
console.log(`DEBUG: Writable Storage Path: ${writableFolder}`);

// Define Internal (App) vs External (User) Paths
const paths = {
    secrets: { int: path.join(__dirname, 'secrets.env'), ext: path.join(writableFolder, 'secrets.env') },
    config: { int: path.join(__dirname, 'app_config.json'), ext: path.join(writableFolder, 'app_config.json') },
    log: { int: path.join(__dirname, 'completed_log.json'), ext: path.join(writableFolder, 'completed_log.json') },
    token: { int: path.join(__dirname, 'zoom_token.json'), ext: path.join(writableFolder, 'zoom_token.json') }
};

// 🔄 BRIDGE LOGIC: Auto-Copy files to Safe Folder if missing
['secrets', 'config', 'log', 'token'].forEach(key => {
    if (fs.existsSync(paths[key].int) && !fs.existsSync(paths[key].ext)) {
        try {
            fs.copyFileSync(paths[key].int, paths[key].ext);
            console.log(`✅ BRIDGE: Installed ${key} to safe folder.`);
        } catch (e) { console.error(`❌ Failed to copy ${key}:`, e.message); }
    }
});

// 1. Load Secrets
const secretsToLoad = fs.existsSync(paths.secrets.ext) ? paths.secrets.ext : paths.secrets.int;
if (fs.existsSync(secretsToLoad)) require('dotenv').config({ path: secretsToLoad });
else console.warn("⚠️ WARNING: secrets.env not found!");

// 2. Load Config (Emails, Topics, Sales Folders)
let APP_CONFIG = { sales_team_folders: {}, ignore_topics: [], ignore_emails: [] };
const configToLoad = fs.existsSync(paths.config.ext) ? paths.config.ext : paths.config.int;
if (fs.existsSync(configToLoad)) {
    try {
        APP_CONFIG = JSON.parse(fs.readFileSync(configToLoad));
        console.log("✅ Loaded app_config.json");
    } catch (e) { console.error("❌ Error parsing app_config.json:", e.message); }
}

console.log("DEBUG: 2. Libraries & Config loaded.");

// --- ⚙️ CONSTANTS (From Env & Config) ---
const CHECK_INTERVAL_MINUTES = 20; 
const SCAN_MONTHS_BACK = 8; 
const CUTOFF_DATE_STR = "2025-08-01"; 

// Now loaded from secrets.env
const BACKUP_FOLDER_ID = process.env.BACKUP_FOLDER_ID; 
const CLICKUP_LAST_1_1_ID = process.env.CLICKUP_LAST_1_1_ID;
const CLICKUP_CHECKIN_ID = process.env.CLICKUP_CHECKIN_ID;

const TEMP_DIR = path.join(os.tmpdir(), 'zoom-watchman-uploads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// Mapped from JSON
const SALES_TEAM_FOLDERS = APP_CONFIG.sales_team_folders || {};
const IGNORE_EMAILS = APP_CONFIG.ignore_emails || [];
const IGNORE_TOPICS = APP_CONFIG.ignore_topics || [];

let FIELD_MAP = { internal: null, member: null };
let CLICKUP_CACHE = []; 

function getFormattedDate(dateString) {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const d = new Date(dateString);
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// ☁️ SYNC FUNCTION
async function syncLogsWithDrive() {
    if (!BACKUP_FOLDER_ID) return;
    console.log("   ☁️ Syncing: Pulling latest log from Google Drive...");
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "http://localhost");
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const fileName = "completed_log_backup.json";

    try {
        const q = `'${BACKUP_FOLDER_ID}' in parents and name = '${fileName}' and trashed = false`;
        const res = await drive.files.list({ q, fields: 'files(id)' });

        if (res.data.files.length > 0) {
            const fileId = res.data.files[0].id;
            console.log("      ⬇️ Found backup. Downloading...");
            const destPath = path.join(TEMP_DIR, 'cloud_backup.json');
            const dest = fs.createWriteStream(destPath);
            const download = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
            
            await new Promise((resolve, reject) => {
                download.data.on('end', resolve).on('error', reject).pipe(dest);
            });

            const cloudLog = JSON.parse(fs.readFileSync(destPath));
            let localLog = [];
            if (fs.existsSync(paths.log.ext)) localLog = JSON.parse(fs.readFileSync(paths.log.ext));
            
            const combinedLog = [...localLog, ...cloudLog];
            const uniqueLog = Array.from(new Map(combinedLog.map(item => [item['uuid'], item])).values());

            fs.writeFileSync(paths.log.ext, JSON.stringify(uniqueLog, null, 2));
            console.log(`      ✅ Sync Complete! Total records: ${uniqueLog.length}`);
            fs.unlinkSync(destPath);
        } else {
            console.log("      ⚠️ No backup found in Drive. Starting with local log only.");
        }
    } catch (e) { console.error("      ⚠️ Sync Failed:", e.message); }
}

async function backupLogToDrive() {
    if (!fs.existsSync(paths.log.ext) || !BACKUP_FOLDER_ID) return;
    console.log("   ☁️ Backing up Log to Google Drive...");
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "http://localhost");
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const fileName = "completed_log_backup.json";

    try {
        const q = `'${BACKUP_FOLDER_ID}' in parents and name = '${fileName}' and trashed = false`;
        const res = await drive.files.list({ q, fields: 'files(id)' });
        const media = { mimeType: 'application/json', body: fs.createReadStream(paths.log.ext) };

        if (res.data.files.length > 0) {
            await drive.files.update({ fileId: res.data.files[0].id, media });
            console.log(`      ✅ Backup Updated`);
        } else {
            await drive.files.create({ resource: { name: fileName, parents: [BACKUP_FOLDER_ID] }, media, fields: 'id' });
            console.log("      ✅ Backup Created");
        }
    } catch (e) { console.error("      ⚠️ Backup Failed:", e.message); }
}

async function sendEmailNotification(status, videoName, brand, details) {
    if (!process.env.EMAIL_USER) return;
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "http://localhost");
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    let subject, text;
    if (status === 'SUCCESS') {
        subject = `✅ Upload Success: ${videoName}`;
        text = `Video: ${videoName}\nBrand: ${brand}\n\n-- LINKS --\n${details}`;
    } else if (status === 'FAIL') {
        subject = `❌ Upload Failed: ${videoName}`;
        text = `Video: ${videoName}\nBrand: ${brand}\n\nFailed to find brand in ClickUp.\nReason: ${details}`;
    } else if (status === 'RETRY') {
        subject = `⚠️ Upload Issue: Retrying ${videoName}`;
        text = `Video: ${videoName}\nBrand: ${brand}\n\nIssue detected. Retrying in ${CHECK_INTERVAL_MINUTES} mins.\n\nDETAILS:\n${details}`;
    }
    
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const message = [`From: <${process.env.EMAIL_USER}>`, `To: <${process.env.EMAIL_USER}>`, `Subject: ${utf8Subject}`, `MIME-Version: 1.0`, `Content-Type: text/plain; charset=utf-8`, ``, text].join('\n');
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try { await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encodedMessage } }); } catch (e) { console.error("   ❌ Failed to send email:", e.message); }
}

async function getZoomAccessToken() {
    if (!fs.existsSync(paths.token.ext)) throw new Error("❌ No Token Found! (Run Setup First)");
    let tokenData = JSON.parse(fs.readFileSync(paths.token.ext));
    
    if (Date.now() >= tokenData.expires_at) {
        console.log('   🔄 Refreshing Zoom Token...');
        const credentials = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
        const res = await axios.post('https://zoom.us/oauth/token', querystring.stringify({ grant_type: 'refresh_token', refresh_token: tokenData.refresh_token }), { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
        tokenData = { access_token: res.data.access_token, refresh_token: res.data.refresh_token, expires_at: Date.now() + (res.data.expires_in * 1000) - 5000 };
        fs.writeFileSync(paths.token.ext, JSON.stringify(tokenData));
    }
    return tokenData.access_token;
}

function saveToLog(newData) {
    let currentLog = [];
    if (fs.existsSync(paths.log.ext)) {
        try { currentLog = JSON.parse(fs.readFileSync(paths.log.ext)); } catch (e) { currentLog = []; }
    }
    const index = currentLog.findIndex(item => item.uuid === newData.uuid);
    if (index !== -1) currentLog[index] = { ...currentLog[index], ...newData };
    else currentLog.push(newData);
    fs.writeFileSync(paths.log.ext, JSON.stringify(currentLog, null, 2));
}

async function markZoomComplete(meetingId, currentTopic, token) {
    if (currentTopic.includes('✅')) return; 
    try {
        const safeId = encodeURIComponent(meetingId);
        await axios.patch(`https://api.zoom.us/v2/meetings/${safeId}`, { topic: `${currentTopic} ✅` }, { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } catch (e) { /* Ignore */ }
}

async function deleteZoomRecording(meetingId, token) {
    try {
        console.log(`      🗑️ Deleting Recording from Zoom...`);
        await axios.delete(`https://api.zoom.us/v2/meetings/${encodeURIComponent(meetingId)}/recordings`, { headers: { 'Authorization': `Bearer ${token}` } });
        return true;
    } catch (e) { return false; }
}

async function refreshClickUpCache() {
    if (!process.env.CLICKUP_LIST_ID || !process.env.CLICKUP_API_KEY) return;
    
    // Get Field IDs (Run once)
    if (!FIELD_MAP.internal) {
        try {
            const res = await axios.get(`https://api.clickup.com/api/v2/list/${process.env.CLICKUP_LIST_ID}/field`, { headers: { 'Authorization': process.env.CLICKUP_API_KEY } });
            FIELD_MAP.internal = res.data.fields.find(f => f.name === process.env.CLICKUP_INTERNAL_COL_NAME)?.id;
            FIELD_MAP.member = res.data.fields.find(f => f.name === process.env.CLICKUP_MEMBER_COL_NAME)?.id;
        } catch (e) { console.error("   ⚠️ ClickUp Setup Error:", e.message); return; }
    }

    console.log("   📥 Downloading ClickUp Database...");
    let allLiteTasks = [], page = 0, keepGoing = true;
    
    while (keepGoing) {
        try {
            const res = await axios.get(`https://api.clickup.com/api/v2/list/${process.env.CLICKUP_LIST_ID}/task?include_closed=true&subtasks=true&page=${page}`, { 
                headers: { 'Authorization': process.env.CLICKUP_API_KEY }, timeout: 60000 
            });
            
            if (!res.data.tasks || res.data.tasks.length === 0) {
                console.log(`\n      ✅ Database synced! (${allLiteTasks.length} tasks total)`);
                keepGoing = false;
            } else {
                allLiteTasks = allLiteTasks.concat(res.data.tasks.map(t => ({ 
                    id: t.id, n: t.name.trim().toLowerCase(), 
                    i: t.custom_fields.find(f => f.id === FIELD_MAP.internal)?.value, 
                    m: t.custom_fields.find(f => f.id === FIELD_MAP.member)?.value 
                })));
                process.stdout.write(`      Page ${page} loaded... (${allLiteTasks.length} tasks)\r`);
                page++;
            }
        } catch (e) { 
            console.error(`\n      ⚠️ Error fetching ClickUp Page ${page}: ${e.message}`);
            if (e.code === 'ECONNABORTED' || (e.response && e.response.status === 504)) await new Promise(resolve => setTimeout(resolve, 5000));
            else keepGoing = false; 
        }
    }
    CLICKUP_CACHE = allLiteTasks;
}

function findFolderLinksInMemory(brandName) {
    const cleanBrand = brandName.trim().toLowerCase();
    let task = CLICKUP_CACHE.find(t => t.n === cleanBrand);
    if (!task) task = CLICKUP_CACHE.find(t => t.n.startsWith(cleanBrand + " ") || t.n.startsWith(cleanBrand + "("));
    if (!task) return null;
    const extractId = (link) => {
        if (!link) return null;
        return (link.includes('id=') ? link.split('id=')[1] : link.split('/').pop()).split('?')[0].trim();
    };
    return { taskId: task.id, internalFolderId: extractId(task.i), memberFolderId: extractId(task.m) };
}

async function updateClickUpSmart(taskId, newDateUnix) {
    if (!taskId) return;
    try {
        const res = await axios.get(`https://api.clickup.com/api/v2/task/${taskId}`, { headers: { 'Authorization': process.env.CLICKUP_API_KEY } });
        const customFields = res.data.custom_fields || [];
        const checkAndUpdate = async (fieldId) => {
            const field = customFields.find(f => f.id === fieldId);
            if (field && newDateUnix > (parseInt(field.value) || 0)) {
                await axios.post(`https://api.clickup.com/api/v2/task/${taskId}/field/${fieldId}`, { value: newDateUnix }, { headers: { 'Authorization': process.env.CLICKUP_API_KEY, 'Content-Type': 'application/json' } });
            }
        };
        if (CLICKUP_LAST_1_1_ID) await checkAndUpdate(CLICKUP_LAST_1_1_ID);
        if (CLICKUP_CHECKIN_ID) await checkAndUpdate(CLICKUP_CHECKIN_ID);
    } catch (e) { console.error(`      ⚠️ ClickUp Update Failed: ${e.message}`); }
}

async function createDriveFolder(folderName, parentId) {
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "http://localhost");
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const safeName = folderName.replace(/[:\/]/g, ' '); 
    const q = `mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and name = '${safeName}' and trashed = false`;
    const checkRes = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    if (checkRes.data.files && checkRes.data.files.length > 0) return checkRes.data.files[0].id; 
    const res = await drive.files.create({ resource: { name: safeName, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }, fields: 'id', supportsAllDrives: true });
    return res.data.id;
}

async function checkFileExistsInDrive(fileName, folderId) {
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "http://localhost");
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const q = `'${folderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`;
    try {
        const res = await drive.files.list({ q, fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true });
        return (res.data.files && res.data.files.length > 0);
    } catch (e) { return false; }
}

async function uploadToDrive(filePath, fileName, folderId) {
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, "http://localhost");
    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    if (!fs.existsSync(filePath)) throw new Error(`CRITICAL: File not found at ${filePath}.`);
    const res = await drive.files.create({ resource: { name: fileName, parents: [folderId] }, media: { mimeType: 'video/mp4', body: fs.createReadStream(filePath) }, fields: 'id', supportsAllDrives: true });
    return res.data;
}

async function checkZoom() {
    try {
        console.log(`\n🕒 Watchman Scan: ${new Date().toLocaleTimeString()}`);
        const token = await getZoomAccessToken();
        let completed = [];
        if (fs.existsSync(paths.log.ext)) try { completed = JSON.parse(fs.readFileSync(paths.log.ext)); } catch (e) { completed = []; }

        const usersRes = await axios.get('https://api.zoom.us/v2/users?page_size=300', { headers: { 'Authorization': `Bearer ${token}` } });
        const users = usersRes.data.users || [];
        const cutoffTime = new Date(CUTOFF_DATE_STR).getTime(); 

        for (const user of users) {
            if (IGNORE_EMAILS.includes(user.email)) continue;
            for (let i = 0; i < SCAN_MONTHS_BACK; i++) {
                let toDate = new Date(); toDate.setMonth(toDate.getMonth() - i);
                let fromDate = new Date(); fromDate.setMonth(fromDate.getMonth() - (i + 1));
                
                try {
                    const res = await axios.get(`https://api.zoom.us/v2/users/${user.id}/recordings?from=${fromDate.toISOString().split('T')[0]}&to=${toDate.toISOString().split('T')[0]}`, { headers: { 'Authorization': `Bearer ${token}` } });
                    if (!res.data.meetings) continue;

                    for (const meeting of res.data.meetings) {
                        try {
                            const meetingTime = new Date(meeting.start_time).getTime();
                            const niceDate = getFormattedDate(meeting.start_time);

                            if (meetingTime < cutoffTime) continue; 
                            if (completed.some(item => item.uuid === meeting.uuid)) continue;
                            if (meeting.topic.includes('✅')) {
                                 saveToLog({ name: meeting.topic, uuid: meeting.uuid, date: niceDate, status: "Marked ✅" });
                                 console.log(`      💾 Skipped (Already Done): ${meeting.topic}`);
                                 continue;
                            }

                            let links = null, brand = "", isSalesEquation = false, shouldSkipForever = false, emailLinksDetail = "";

                            if (SALES_TEAM_FOLDERS[user.email]) {
                                if (!meeting.topic.includes(' x ') || !meeting.topic.includes('EE Scale Session')) shouldSkipForever = true; 
                                else {
                                    console.log(`   🚀 Sales Video: "${meeting.topic}"`);
                                    try {
                                        const subFolderId = await createDriveFolder(meeting.topic, SALES_TEAM_FOLDERS[user.email]);
                                        links = { internalFolderId: subFolderId, memberFolderId: subFolderId };
                                        isSalesEquation = true;
                                        brand = "Sales Equation";
                                        emailLinksDetail = `📂 Folder: https://drive.google.com/drive/folders/${subFolderId}`;
                                    } catch (e) { console.error(`      ❌ Folder Error: ${e.message}`); continue; }
                                }
                            } else {
                                if (IGNORE_TOPICS.some(ignored => meeting.topic.includes(ignored)) || meeting.topic.includes("1:1")) shouldSkipForever = true;
                                else {
                                    const nameParts = meeting.topic.split(' x ');
                                    if (nameParts.length < 2) shouldSkipForever = true; 
                                    else {
                                        const left = nameParts[0].trim(), right = nameParts[1].split('-')[0].trim();
                                        const linksLeft = findFolderLinksInMemory(left), linksRight = findFolderLinksInMemory(right);
                                        
                                        if (linksLeft) { brand = left; links = linksLeft; }
                                        else if (linksRight) { brand = right; links = linksRight; }
                                        else { brand = left; links = null; }

                                        if (links) {
                                            console.log(`   🚀 Standard Video: "${meeting.topic}" (Brand: ${brand})`);
                                            emailLinksDetail = `📂 Member: https://drive.google.com/drive/folders/${links.memberFolderId}\n📂 Internal: https://drive.google.com/drive/folders/${links.internalFolderId}`;
                                        }
                                    }
                                }
                            }

                            if (shouldSkipForever) continue;
                            if (!links || !links.internalFolderId) {
                                console.log(`      ❌ Brand "${brand}" not found.`);
                                await sendEmailNotification('FAIL', meeting.topic, brand, "Brand not found in ClickUp.");
                                continue;
                            }

                            console.log(`      ✅ Uploading to Brand: ${brand}...`);
                            let validUploadQueue = [], corruptedFiles = [];

                            for (const file of meeting.recording_files) {
                                if (file.file_extension === 'JSON' || file.file_type === 'TIMELINE') continue;
                                const isTextFile = (file.file_extension === 'TXT') || file.file_type === 'CHAT';
                                if (!isTextFile && file.file_size < 1024) continue; 
                                
                                let fileExt = file.file_type === 'MP4' ? '.mp4' : (file.file_type === 'M4A' ? '.m4a' : (file.file_type === 'CHAT' ? '.txt' : `.${file.file_extension.toLowerCase()}`));
                                let finalFileName = `${meeting.topic.replace(/[^a-zA-Z0-9 \-\.]/g, '').trim()} - ${niceDate.replace(/[^a-zA-Z0-9 \-\.]/g, '')}${fileExt}`;
                                const tempPath = path.join(TEMP_DIR, finalFileName);
                                let targetFolder = (!isSalesEquation && file.file_type === 'MP4' && user.email !== 'travis@ecommerceequation.com.au') ? links.memberFolderId : links.internalFolderId;

                                if (await checkFileExistsInDrive(finalFileName, targetFolder)) {
                                    console.log(`      ⏩ Exists: "${finalFileName}"`);
                                    continue;
                                }

                                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                                try {
                                    const writer = fs.createWriteStream(tempPath);
                                    const streamRes = await axios({ url: `${file.download_url}?access_token=${token}`, method: 'GET', responseType: 'stream' });
                                    streamRes.data.pipe(writer);
                                    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
                                    
                                    const stats = fs.statSync(tempPath);
                                    if (file.file_size > 0 && stats.size !== file.file_size) throw new Error("File size mismatch");
                                    
                                    validUploadQueue.push({ path: tempPath, name: finalFileName, target: targetFolder });
                                } catch (err) { 
                                    console.error(`      ⚠️ Download Failed: ${err.message}`);
                                    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                                    corruptedFiles.push(finalFileName);
                                }
                            }

                            if (validUploadQueue.length > 0) {
                                for (const item of validUploadQueue) {
                                    try {
                                        await uploadToDrive(item.path, item.name, item.target);
                                        console.log(`      ✅ Uploaded: ${item.name}`);
                                    } catch (e) {
                                        console.error(`      ❌ Upload Failed: ${item.name}`);
                                        corruptedFiles.push(item.name);
                                    } finally { if (fs.existsSync(item.path)) fs.unlinkSync(item.path); }
                                }
                            }

                            if (corruptedFiles.length === 0) {
                                console.log("      🎉 Batch Complete.");
                                if (!isSalesEquation) await deleteZoomRecording(meeting.uuid, token) || await markZoomComplete(meeting.uuid, meeting.topic, token);
                                else await markZoomComplete(meeting.uuid, meeting.topic, token);

                                if (validUploadQueue.length > 0) await sendEmailNotification('SUCCESS', meeting.topic, brand, emailLinksDetail);
                                saveToLog({ name: meeting.topic, uuid: meeting.uuid, date: niceDate, link: meeting.share_url, status: "Uploaded" });
                                if (!isSalesEquation && links.taskId) await updateClickUpSmart(links.taskId, new Date(meeting.start_time).getTime());
                            } else {
                                console.log("      🛑 Batch Failed.");
                                await sendEmailNotification('RETRY', meeting.topic, brand, corruptedFiles.join("\n"));
                            }
                        } catch (meetingErr) { console.error(`      🔥 MEETING ERROR:`, meetingErr.message); }
                    }
                } catch (err) {}
            }
        }
    } catch (error) { console.error("❌ Watchman Error:", error.message); }
}

(async () => {
    console.log("🚀 Starting Server...");
    await syncLogsWithDrive();
    await refreshClickUpCache(); 
    while (true) {
        try { 
            await checkZoom(); 
            await backupLogToDrive(); 
        } catch (e) { console.error("❌ Critical Loop Error:", e.message); }
        console.log(`💤 Sleeping for ${CHECK_INTERVAL_MINUTES} minutes...`);
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_MINUTES * 60 * 1000));
    }
})();