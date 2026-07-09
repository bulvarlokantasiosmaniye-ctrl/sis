/* =========================================================
   SON DEPREMLER TR — Ortak arayüz davranışları
   ========================================================= */

document.addEventListener('DOMContentLoaded', () => {
  // Mobil menü
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
    nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.classList.remove('open')));
  }

  // Aktif nav linkini işaretle
  const path = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === path || (path === '' && href === 'index.html')) a.classList.add('active');
  });

  initSeismoStrip();
});

/* ---------- Sismogram şeridi (imza öge) ---------- */
function initSeismoStrip(magnitudes) {
  const el = document.getElementById('seismoSvg');
  if (!el) return;

  const W = 1200, H = 56, MID = H / 2;
  const points = magnitudes && magnitudes.length ? magnitudes.slice(0, 40).reverse() : null;

  let path = '';
  let hasAlert = false;
  const step = W / 60;

  for (let i = 0; i <= 60; i++) {
    let amp;
    if (points && points[i % points.length] !== undefined) {
      const m = points[i % points.length];
      amp = Math.min(m, 6) * 3.2;
      if (m >= 4.5) hasAlert = true;
    } else {
      amp = Math.sin(i * 0.7) * 3 + Math.random() * 2;
    }
    const jitter = (Math.random() - 0.5) * 2;
    const y = MID + (i % 7 === 0 ? amp + jitter : jitter * 1.5);
    path += `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(1)} ${y.toFixed(1)} `;
  }

  el.innerHTML = `
    <line x1="0" y1="${MID}" x2="${W}" y2="${MID}" class="grid-line" stroke-dasharray="2 4"/>
    <path d="${path}" class="trace ${hasAlert ? 'alert' : ''}" />
  `;
}
