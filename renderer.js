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
    
    // Simple UI coloring logic
    if (data.includes('✅')) line.style.color = '#4ade80';
    if (data.includes('❌')) line.style.color = '#f87171';
    if (data.includes('🚀')) line.style.color = '#fbbf24';
    
    line.innerText = data;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
});