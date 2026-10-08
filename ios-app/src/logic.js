// Etkinik — platformdan bağımsız mantık (web sürümüyle aynı kurallar)

export const RADIUS_MIN = 10;
export const RADIUS_MAX = 300;
export const RADIUS_DEFAULT = 100;
export const MODES = { LOCATION: 'location', TIME: 'time', BOTH: 'both' };
export const MODE_LABELS = { location: 'Yalnızca konum', time: 'Yalnızca saat', both: 'Konum + saat' };
export const REPEAT_OPTIONS = [0, 5, 10, 15, 30];
export const GEO_FRESH_MS = 10 * 60 * 1000;

export const pad = (n) => String(n).padStart(2, '0');
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fmtTime = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const minutesOfDay = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const usesLocation = (mode) => mode === MODES.LOCATION || mode === MODES.BOTH;
export const usesTime = (mode) => mode === MODES.TIME || mode === MODES.BOTH;

export function parseHHMM(s) {
  if (!/^\d{1,2}:\d{2}$/.test((s || '').trim())) return null;
  const [h, m] = s.trim().split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

export function normalizeHHMM(s) {
  const m = parseHHMM(s);
  return m == null ? '' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Bugünün belirli bir "SS:DD" saatindeki zaman damgası */
export function todayAt(hhmm, base = new Date()) {
  const m = parseHHMM(hhmm);
  if (m == null) return null;
  const d = new Date(base);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d.getTime();
}

export function fmtDistance(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

export function newWorkplace(name) {
  return {
    id: uid(),
    name: name || 'Merkez Ofis',
    lat: null,
    lon: null,
    radius: RADIUS_DEFAULT,
    start: '08:30',
    end: '18:00',
    mode: MODES.BOTH,
    repeat: 10,
  };
}

export const hasCoords = (wp) =>
  !!wp && typeof wp.lat === 'number' && typeof wp.lon === 'number' && isFinite(wp.lat) && isFinite(wp.lon);

/** Haversine — metre */
export function distance(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function radiusError(str) {
  const s = String(str ?? '').trim();
  if (s === '') return 'Kapsama alanını girin (10–300 m).';
  if (!/^\d+$/.test(s)) return 'Kapsama alanı metre cinsinden tam sayı olmalı (ör. 58).';
  const n = Number(s);
  if (n < RADIUS_MIN) return `Kapsama alanı en az ${RADIUS_MIN} m olabilir.`;
  if (n > RADIUS_MAX) return `Kapsama alanı en fazla ${RADIUS_MAX} m olabilir.`;
  return null;
}

function parseCoord(str) {
  const s = String(str ?? '').trim().replace(',', '.');
  if (s === '') return { empty: true };
  if (!/^[-+]?\d{1,3}(\.\d+)?$/.test(s)) return { invalid: true };
  return { value: Number(s) };
}

/** Form doğrulama. { ok, errors, wp } */
export function validateWorkplace(base, v) {
  const errors = {};
  const wp = { ...base };

  wp.name = (v.name || '').trim();
  if (!wp.name) errors.name = 'İş yeri adını girin.';

  wp.mode = Object.values(MODES).includes(v.mode) ? v.mode : MODES.BOTH;
  const needsLocation = wp.mode !== MODES.TIME;
  const needsTime = wp.mode !== MODES.LOCATION;

  const lat = parseCoord(v.lat);
  const lon = parseCoord(v.lon);
  if (lat.empty && lon.empty) {
    wp.lat = null;
    wp.lon = null;
    if (needsLocation) errors.coords = 'İş yeri konumu ayarlanmamış. "Mevcut konumumu iş yeri yap" butonunu kullanın veya enlem/boylam girin.';
  } else if (lat.empty || lon.empty) {
    errors.coords = 'Enlem ve boylamın ikisi de girilmeli.';
  } else if (lat.invalid || lon.invalid) {
    errors.coords = 'Geçersiz koordinat. Örnek: 41.008200 ve 28.978400';
  } else if (lat.value < -90 || lat.value > 90) {
    errors.coords = 'Geçersiz enlem. Enlem -90 ile 90 arasında olmalı.';
  } else if (lon.value < -180 || lon.value > 180) {
    errors.coords = 'Geçersiz boylam. Boylam -180 ile 180 arasında olmalı.';
  } else if (lat.value === 0 && lon.value === 0) {
    errors.coords = 'Geçersiz koordinat (0, 0). Gerçek iş yeri konumunu girin.';
  } else {
    wp.lat = lat.value;
    wp.lon = lon.value;
  }

  const rErr = radiusError(v.radius);
  if (rErr) errors.radius = rErr;
  else wp.radius = Number(String(v.radius).trim());

  const sMin = parseHHMM(v.start);
  const eMin = parseHHMM(v.end);
  const sBad = (v.start || '').trim() !== '' && sMin == null;
  const eBad = (v.end || '').trim() !== '' && eMin == null;
  wp.start = normalizeHHMM(v.start);
  wp.end = normalizeHHMM(v.end);
  if (sBad || eBad) errors.hours = 'Saat biçimi SS:DD olmalı (ör. 08:30).';
  else if (needsTime && sMin == null && eMin == null) errors.hours = 'Mesai saatleri girilmemiş. Başlangıç ve bitiş saatini girin.';
  else if (needsTime && sMin == null) errors.hours = 'Mesai başlangıç saatini girin.';
  else if (needsTime && eMin == null) errors.hours = 'Mesai bitiş saatini girin.';
  else if (sMin != null && eMin != null && eMin <= sMin) errors.hours = 'Mesai bitişi başlangıçtan sonra olmalı (gece vardiyası bu sürümde desteklenmiyor).';

  const rep = Number(v.repeat);
  wp.repeat = REPEAT_OPTIONS.includes(rep) ? rep : 10;

  return { ok: Object.keys(errors).length === 0, errors, wp };
}

export function geoStatus(wp, pos, now) {
  if (!hasCoords(wp)) return { state: 'nocoords' };
  if (!pos) return { state: 'nodata' };
  const dist = distance(pos, { lat: wp.lat, lon: wp.lon });
  const inside = dist <= wp.radius;
  return {
    state: inside ? 'inside' : 'outside',
    inside,
    distance: dist,
    accuracy: pos.accuracy,
    time: pos.time,
    stale: now - pos.time > GEO_FRESH_MS,
  };
}

/**
 * Saf karar fonksiyonu: hiçbir kayıt oluşturmaz.
 * state.lastPos: ön planda alınan son konum
 * rec.leftAt: arka plan geofencing'in bildirdiği son "alandan çıkış" zamanı
 */
export function evaluate(state, wp, rec, now = Date.now()) {
  const pos = state.lastPos;
  const geo = geoStatus(wp, pos, now);
  const nowMin = minutesOfDay(new Date(now));
  const startMin = parseHHMM(wp.start);
  const endMin = parseHHMM(wp.end);
  const hasEntry = !!(rec && rec.entry);
  const hasExit = !!(rec && rec.exit);
  const exitReasons = [];
  const entryReasons = [];

  if (hasEntry && !hasExit) {
    if (usesLocation(wp.mode)) {
      const fgOutside = rec.seenInside && geo.state === 'outside' && pos.time > rec.entry;
      const bgOutside = !!rec.leftAt && rec.leftAt > rec.entry && !(rec.backAt && rec.backAt > rec.leftAt);
      if (fgOutside || bgOutside) exitReasons.push('location');
    }
    if (usesTime(wp.mode) && endMin != null && nowMin >= endMin) exitReasons.push('time');
  }

  if (!hasEntry && !hasExit) {
    if (usesLocation(wp.mode) && geo.state === 'inside' && !geo.stale) entryReasons.push('location');
    if (usesTime(wp.mode) && startMin != null && endMin != null && nowMin >= startMin && nowMin < endMin) entryReasons.push('time');
  }

  return {
    now, wp, rec, geo, hasEntry, hasExit, exitReasons, entryReasons,
    exitDue: exitReasons.length > 0,
    entryDue: entryReasons.length > 0,
  };
}

export function exitMessage(ev) {
  const lines = ['Çıkış yapılmadı.'];
  if (ev.exitReasons.includes('location')) lines.push('İş yerinden ayrılmış görünüyorsunuz.');
  if (ev.exitReasons.includes('time')) lines.push(`Mesai bitiş saati (${ev.wp.end}) geldi.`);
  lines.push('İK uygulamanızda çıkış yapmayı unutma.');
  return lines.join('\n');
}

export function entryMessage(ev) {
  const lines = [];
  if (ev.entryReasons.includes('location')) lines.push(`${ev.wp.name} alanındasınız.`);
  if (ev.entryReasons.includes('time')) lines.push(`Mesai ${ev.wp.start}'da başladı.`);
  lines.push('İK uygulamanızda giriş yaptıysanız "Giriş yaptım"a basın.');
  return lines.join('\n');
}
