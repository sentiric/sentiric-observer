export const CONFIG = {
    WS_URL: `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`,
    MAX_LOGS: 10000, 
    ROW_HEIGHT: 26,  
    CHART_POINTS: 200
};