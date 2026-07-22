// Lazy-load the Google Maps JavaScript API once per page lifetime.
let mapsPromise = null;

export function loadGoogleMaps(apiKey) {
  if (!apiKey) return Promise.reject(new Error('Missing Google Maps API key'));
  if (typeof window !== 'undefined' && window.google?.maps) {
    return Promise.resolve(window.google.maps);
  }
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-c911-maps]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.google.maps));
      existing.addEventListener('error', () => reject(new Error('Google Maps failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}`;
    s.async = true;
    s.defer = true;
    s.dataset.c911Maps = '1';
    s.onload = () => {
      if (!window.google?.maps) reject(new Error('Google Maps failed to initialize'));
      else resolve(window.google.maps);
    };
    s.onerror = () => {
      mapsPromise = null;
      reject(new Error('Google Maps script blocked or invalid key'));
    };
    document.head.appendChild(s);
  });
  return mapsPromise;
}

/** Marker colors for pin kinds. */
export const PIN_COLORS = {
  open: '#2e9e5b', // clocked in now
  in: '#0f2740',   // today's clock-in
  out: '#e8792b',  // today's clock-out
};
