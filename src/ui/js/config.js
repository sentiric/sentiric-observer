const CONFIG = {
    WS_URL: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    MAX_LOGS: 5000,
    ROW_HEIGHT: 24,
    CHART_POINTS: 150
};
// Konsola yüklendiğini teyit edelim
console.log("⚙️ UI Config Loaded:", CONFIG);