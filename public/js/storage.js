/**
 * BeamDrop Storage & State Persistence Module
 * Manages device profile, preferences, and session transfer history.
 */

const STORAGE_KEYS = {
  DEVICE_TYPE: 'beamdrop_device_type',
  DEVICE_NAME: 'beamdrop_device_name',
  THEME: 'beamdrop_theme',
  ONBOARDING_DONE: 'beamdrop_onboarded',
  SESSION_HISTORY: 'beamdrop_session_history'
};

/**
 * Detect client OS / platform from User Agent
 * @returns {'ios' | 'android' | 'windows' | 'desktop'}
 */
export function detectDeviceType() {
  const ua = navigator.userAgent || '';

  if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) {
    return 'ios';
  }
  if (/Android/.test(ua)) {
    return 'android';
  }
  if (/Windows/.test(ua)) {
    return 'windows';
  }
  return 'desktop';
}

/**
 * Generate a friendly initial device name
 * @param {'ios' | 'android' | 'windows' | 'desktop'} deviceType
 * @returns {string}
 */
export function generateDefaultDeviceName(deviceType) {
  const adjectives = ['Swift', 'Bright', 'Cosmic', 'Solar', 'Lunar', 'Silver', 'Amber', 'Breezy', 'Echo', 'Nova'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];

  switch (deviceType) {
    case 'ios':
      return `${adj} iPhone`;
    case 'android':
      return `${adj} Android`;
    case 'windows':
      return `${adj} PC`;
    default:
      return `${adj} Laptop`;
  }
}

/**
 * Get current device profile from localStorage
 */
export function getDeviceProfile() {
  const detectedType = detectDeviceType();
  const storedType = localStorage.getItem(STORAGE_KEYS.DEVICE_TYPE);
  const storedName = localStorage.getItem(STORAGE_KEYS.DEVICE_NAME);
  const onboarded = localStorage.getItem(STORAGE_KEYS.ONBOARDING_DONE) === 'true';

  const deviceType = storedType || detectedType;
  const deviceName = storedName || generateDefaultDeviceName(deviceType);

  return {
    deviceType,
    deviceName,
    detectedType,
    onboarded
  };
}

/**
 * Save device profile to localStorage
 */
export function saveDeviceProfile(deviceType, deviceName) {
  if (deviceType) {
    localStorage.setItem(STORAGE_KEYS.DEVICE_TYPE, deviceType);
  }
  if (deviceName && deviceName.trim()) {
    localStorage.setItem(STORAGE_KEYS.DEVICE_NAME, deviceName.trim());
  }
  localStorage.setItem(STORAGE_KEYS.ONBOARDING_DONE, 'true');
}

/**
 * Theme management
 */
export function getThemePreference() {
  const saved = localStorage.getItem(STORAGE_KEYS.THEME);
  if (saved === 'dark' || saved === 'light') return saved;
  // Follow system preference by default
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function saveThemePreference(theme) {
  localStorage.setItem(STORAGE_KEYS.THEME, theme);
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Session Transfer History (kept in memory and sessionStorage)
 */
let sessionHistory = [];

export function getSessionHistory() {
  if (sessionHistory.length === 0) {
    try {
      const stored = sessionStorage.getItem(STORAGE_KEYS.SESSION_HISTORY);
      if (stored) {
        sessionHistory = JSON.parse(stored);
      }
    } catch (e) {
      sessionHistory = [];
    }
  }
  return sessionHistory;
}

export function addHistoryEntry(entry) {
  const fullEntry = {
    id: entry.id || 'h_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: Date.now(),
    direction: entry.direction, // 'sent' | 'received'
    peerName: entry.peerName,
    peerType: entry.peerType,
    filesCount: entry.filesCount !== undefined ? entry.filesCount : (entry.isText ? 1 : 0),
    totalSize: entry.totalSize !== undefined ? entry.totalSize : (entry.isText ? (entry.textContent ? entry.textContent.length : 0) : 0),
    status: entry.status || 'completed', // 'completed' | 'cancelled' | 'failed'
    isText: Boolean(entry.isText),
    textContent: entry.textContent || null,
    files: entry.files || []
  };

  sessionHistory.unshift(fullEntry);
  try {
    // Only persist lightweight metadata to sessionStorage (exclude large blob references)
    const sanitized = sessionHistory.map(item => ({
      ...item,
      files: (item.files || []).map(f => ({ name: f.name, size: f.size, type: f.type }))
    }));
    sessionStorage.setItem(STORAGE_KEYS.SESSION_HISTORY, JSON.stringify(sanitized.slice(0, 50)));
  } catch (e) {}

  return fullEntry;
}

export function clearSessionHistory() {
  sessionHistory = [];
  try {
    sessionStorage.removeItem(STORAGE_KEYS.SESSION_HISTORY);
  } catch (e) {}
}
