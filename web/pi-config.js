// In production, publish this interface behind the same reverse proxy as the API.
// For a different endpoint, define window.RUNTIME_MONITOR_API before app.js loads.
window.RUNTIME_MONITOR_API = window.RUNTIME_MONITOR_API || '/api/v1/status';
