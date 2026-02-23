const CONFIG = {
    WS_URL: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    MAX_LOGS: 10000, // RAM'i şişirmemek için son 10 bin log
    ROW_HEIGHT: 26,  // Her satırın px yüksekliği (Virtual Scroll için şart)
    CHART_POINTS: 200
};
console.log("⚙️ Panopticon Config Loaded v4.x", CONFIG);