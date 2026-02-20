const terminal = document.getElementById('terminal');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const clearBtn = document.getElementById('clearBtn');
const statusSpan = document.querySelector('#statusIndicator span');

startBtn.onclick = () => {
    window.electronAPI.startBot();
    statusSpan.innerText = "Running";
    document.getElementById('statusIndicator').className = 'status-running';
};

stopBtn.onclick = () => {
    window.electronAPI.stopBot();
    statusSpan.innerText = "Stopped";
    document.getElementById('statusIndicator').className = 'status-stopped';
};

clearBtn.onclick = () => {
    terminal.innerHTML = '<div class="log-line system">Logs cleared.</div>';
};

exportBtn.onclick = async () => {
    const content = terminal.innerText;
    const path = await window.electronAPI.saveLog(content);
    if (path) alert(`Logs saved to: ${path}`);
};

window.electronAPI.receiveLogs((data) => {
    const line = document.createElement('div');
    line.className = 'log-line';
    
    if (data.includes('✅')) line.style.color = '#4ade80';
    if (data.includes('❌')) line.style.color = '#f87171';
    if (data.includes('🚀')) line.style.color = '#fbbf24';
    
    line.innerText = data;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
});

// Add this at the bottom of your renderer.js
document.getElementById('report-bug-btn').onclick = () => {
    // This calls the bridge we are about to make in preload.js
    window.electronAPI.sendBugReport();
};

async function loadChangelog() {
    const changelogBox = document.getElementById('changelog-list');
    try {
        // Change this URL to your Raw GitHub link for "Live" updates
        const response = await fetch('changelog.json'); 
        const data = await response.json();

        changelogBox.innerHTML = ''; // Clear the "Loading" text

        data.forEach(release => {
            const section = document.createElement('div');
            section.innerHTML = `
                <strong style="color: #4ade80; display: block; margin-top: 10px; font-size: 12px;">
                    ${release.version} 
                    <span style="font-size: 9px; color: #666; font-weight: normal;">(${release.date})</span>
                </strong>
                <ul style="padding-left: 15px; margin-top: 3px; font-size: 11px; color: #bbb;">
                    ${release.changes.map(change => `<li style="margin-bottom: 4px;">${change}</li>`).join('')}
                </ul>
            `;
            changelogBox.appendChild(section);
        });
    } catch (err) {
        changelogBox.innerHTML = '<p style="color: #f87171;">Failed to load history.</p>';
    }
}

// Run it when the app starts
loadChangelog();