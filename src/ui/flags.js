/* Flags for the profile pickers, as inline SVG: Windows has no flag emoji and
 * would draw the letters "US" / "DE" instead. Shared by the app's Settings
 * window and the browser manager (served as /flags.js). Static markup only,
 * built from numbers in this file. */
(() => {
  'use strict';

  function starPoints(cx, cy, outer, inner) {
    const points = [];
    for (let i = 0; i < 10; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = (Math.PI / 5) * i - Math.PI / 2;
      points.push((cx + radius * Math.cos(angle)).toFixed(2) + ',' + (cy + radius * Math.sin(angle)).toFixed(2));
    }
    return points.join(' ');
  }

  const FLAGS = {
    us: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#fff"/>' +
      [0, 1, 2, 3, 4, 5, 6].map((i) => '<rect y="' + (i * 2 * 20 / 13).toFixed(2) + '" width="30" height="' + (20 / 13).toFixed(2) + '" fill="#b22234"/>').join('') +
      '<rect width="12" height="10.77" fill="#3c3b6e"/></svg>',
    gb: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#012169"/>' +
      '<path d="M0 0L30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0L30 20M30 0L0 20" stroke="#c8102e" stroke-width="1.6"/>' +
      '<path d="M15 0V20M0 10H30" stroke="#fff" stroke-width="6"/><path d="M15 0V20M0 10H30" stroke="#c8102e" stroke-width="3.4"/></svg>',
    de: '<svg viewBox="0 0 30 20"><rect width="30" height="6.67" fill="#000"/><rect y="6.67" width="30" height="6.67" fill="#dd0000"/><rect y="13.33" width="30" height="6.67" fill="#ffce00"/></svg>',
    fr: '<svg viewBox="0 0 30 20"><rect width="10" height="20" fill="#002395"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#ed2939"/></svg>',
    es: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#aa151b"/><rect y="5" width="30" height="10" fill="#f1bf00"/></svg>',
    tn: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#e70013"/><circle cx="15" cy="10" r="5.6" fill="#fff"/>' +
      '<circle cx="14.1" cy="10" r="4.2" fill="#e70013"/><circle cx="15.5" cy="10" r="3.4" fill="#fff"/>' +
      '<circle cx="16.2" cy="10" r="2.7" fill="#e70013"/><polygon points="' + starPoints(16.1, 10, 2.1, 0.9) + '" fill="#fff"/>' +
      '<polygon points="' + starPoints(16.1, 10, 1.6, 0.7) + '" fill="#e70013"/></svg>',
    custom: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#3a3a44"/><rect x="5" y="5" width="20" height="2" rx="1" fill="#9aa"/>' +
      '<rect x="5" y="9" width="20" height="2" rx="1" fill="#9aa"/><rect x="5" y="13" width="20" height="2" rx="1" fill="#9aa"/>' +
      '<circle cx="20" cy="6" r="2.4" fill="#ff8a4c"/><circle cx="10" cy="10" r="2.4" fill="#ff8a4c"/><circle cx="17" cy="14" r="2.4" fill="#ff8a4c"/></svg>',
    // "No profile": a globe, since it is the multilingual default.
    none: '<svg viewBox="0 0 30 20"><rect width="30" height="20" fill="#2a2a33"/>' +
      '<circle cx="15" cy="10" r="6.5" fill="none" stroke="#c9c9d6" stroke-width="1.2"/>' +
      '<ellipse cx="15" cy="10" rx="2.8" ry="6.5" fill="none" stroke="#c9c9d6" stroke-width="1"/>' +
      '<path d="M8.5 10H21.5M9.6 6.5H20.4M9.6 13.5H20.4" stroke="#c9c9d6" stroke-width="0.9"/></svg>'
  };

  const LABELS = { us: 'United States', gb: 'United Kingdom', de: 'Germany', fr: 'France', es: 'Spain', tn: 'Tunisia', custom: 'Generic', none: 'No profile' };

  window.MeetScribeFlags = { svg: (code) => FLAGS[code] || FLAGS.custom, codes: Object.keys(LABELS).filter((code) => code !== 'none'), label: (code) => LABELS[code] || code };
})();
