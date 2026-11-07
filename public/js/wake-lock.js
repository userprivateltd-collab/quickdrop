/**
 * BeamDrop Screen Wake Lock Controller
 * Prevents mobile and laptop screens from sleeping during active file transfers.
 */

let wakeLockSentinel = null;

/**
 * Request Screen Wake Lock
 */
export async function requestWakeLock() {
  if ('wakeLock' in navigator && navigator.wakeLock) {
    try {
      if (!wakeLockSentinel || wakeLockSentinel.released) {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
          console.log('[BeamDrop] Wake Lock released.');
        });
        console.log('[BeamDrop] Screen Wake Lock active.');
      }
    } catch (err) {
      console.warn('[BeamDrop] Screen Wake Lock request failed:', err.message);
    }
  }
}

/**
 * Release Screen Wake Lock
 */
export async function releaseWakeLock() {
  if (wakeLockSentinel && !wakeLockSentinel.released) {
    try {
      await wakeLockSentinel.release();
    } catch (err) {
      console.warn('[BeamDrop] Error releasing wake lock:', err);
    } finally {
      wakeLockSentinel = null;
    }
  }
}
