// Tiny wrappers around Web Storage. Every access is wrapped in try/catch
// because storage can throw (private mode, blocked cookies, quota).

const PREFIX = 'rookery:';

function safe(area) {
  try { return area === 'session' ? window.sessionStorage : window.localStorage; } catch { return null; }
}

export function load(key, fallback, area = 'local') {
  try {
    const s = safe(area);
    const raw = s && s.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value, area = 'local') {
  try {
    const s = safe(area);
    if (s) s.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* ignore */ }
}

export function remove(key, area = 'local') {
  try {
    const s = safe(area);
    if (s) s.removeItem(PREFIX + key);
  } catch { /* ignore */ }
}
