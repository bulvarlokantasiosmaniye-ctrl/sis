/* =========================================================
   SON DEPREMLER TR — API katmanı
   Veri kaynağı: Kandilli Rasathanesi / AFAD (orhanaydogdu.com.tr API)
   Bkz. hakkinda.html için atıf ve kullanım koşulları
   ========================================================= */

const API_BASE = 'https://api.orhanaydogdu.com.tr/deprem';

/**
 * Son depremleri getirir.
 * @param {Object} opts
 * @param {'all'|'kandilli'|'afad'} opts.provider
 * @param {number} opts.limit
 * @param {number} opts.skip
 */
async function fetchLiveEarthquakes({ provider = 'all', limit = 60, skip = 0 } = {}) {
  const path = provider === 'all' ? '' : `/${provider}/live`;
  const url = `${API_BASE}${path}?limit=${limit}&skip=${skip}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Veri alınamadı (' + res.status + ')');
  const data = await res.json();
  if (!data || data.status !== true) throw new Error('API geçersiz yanıt döndürdü');
  return data.result || [];
}

/** Şehir listesini getirir (plaka kodu, isim, nüfus). */
async function fetchCities() {
  const res = await fetch(`${API_BASE}/statics/cities`);
  if (!res.ok) throw new Error('Şehir listesi alınamadı');
  const data = await res.json();
  return data.result || [];
}

/* ---------- Yardımcı fonksiyonlar ---------- */

function magClass(mag) {
  if (mag >= 5) return 'critical';
  if (mag >= 3.5) return 'warn';
  return 'safe';
}

function timeAgo(dateTimeStr) {
  // "2024-01-08 11:45:23" formatı TR saatiyle (GMT+3) geliyor
  const iso = dateTimeStr.replace(' ', 'T') + '+03:00';
  const then = new Date(iso).getTime();
  const now = Date.now();
  let diff = Math.max(0, Math.floor((now - then) / 1000));

  if (diff < 60) return 'az önce';
  const min = Math.floor(diff / 60);
  if (min < 60) return `${min} dk önce`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} sa önce`;
  const day = Math.floor(hr / 24);
  return `${day} gün önce`;
}

function formatDateTime(dateTimeStr) {
  const iso = dateTimeStr.replace(' ', 'T') + '+03:00';
  const d = new Date(iso);
  return d.toLocaleString('tr-TR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function titleCaseLocation(title) {
  if (!title) return '';
  return title
    .toLocaleLowerCase('tr-TR')
    .split(' ')
    .map(w => w.length ? w.charAt(0).toLocaleUpperCase('tr-TR') + w.slice(1) : w)
    .join(' ');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
