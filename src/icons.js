// Line icons (same style as the tab bar). Used instead of emoji, which render
// differently on every platform.

const PATHS = {
  // blood pressure: a manometer gauge
  gauge: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-5"/><path d="M4 17h16"/>',
  // blood sugar: a drop
  drop: '<path d="M12 3.5s6 6.4 6 10.8a6 6 0 0 1-12 0C6 9.9 12 3.5 12 3.5z"/>',
  // weight: a bathroom scale with its display
  scale: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><rect x="8.5" y="7" width="7" height="3.5" rx="1"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.1 4.1 0 0 1 12 7.4a4.1 4.1 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z"/>',
  camera: '<path d="M4 8h3.2l1.8-2.5h6l1.8 2.5H20v11H4z"/><circle cx="12" cy="13.2" r="3.4"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-8.5 8.5"/>',
  cloud: '<path d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 11.6a3.45 3.45 0 0 0 .5 6.9z"/>',
  cloudOff: '<path d="M7.5 18.5h9.5a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 11.6a3.45 3.45 0 0 0 .5 6.9z"/><path d="M4 4l16 16"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 20V9"/><path d="m7.5 13.5 4.5-4.5 4.5 4.5"/><path d="M5 4h14"/>',
  sparkle: '<path d="M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8z"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 7.8v.2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8"/><path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8"/><path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16"/><path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M8 12h8"/>',
  retake: '<path d="M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.8 3.5v3.6h-3.6"/><path d="M19.5 12a7.5 7.5 0 0 1-13 5.1"/><path d="M6.2 20.5v-3.6h3.6"/>',
};

/** SVG markup for an icon (for HTML strings such as chart tooltips). */
export function iconSVG(name, size = 18) {
  return (
    `<svg class="ico-svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ''}</svg>`
  );
}

/** An icon element. */
export function icon(name, size = 18) {
  const t = document.createElement('template');
  t.innerHTML = iconSVG(name, size);
  return t.content.firstChild;
}
