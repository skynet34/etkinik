// Etkinik — platformdan bağımsız mantık (web sürümüyle aynı kurallar)

export const RADIUS_MIN = 10;
export const RADIUS_MAX = 300;
export const RADIUS_DEFAULT = 100;
export const MODES = { LOCATION: 'location', TIME: 'time', BOTH: 'both' };
export const MODE_LABELS = { location: 'Yalnızca konum', time: 'Yalnızca saat', both: 'Konum + saat' };
export const WORK_DAYS = [1, 2, 3, 4, 5];
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
// Location modes require a boundary event AND the permitted time window.
export const usesTime = (mode) => mode === MODES.TIME;

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
    entryRadius: RADIUS_DEFAULT,
    exitRadius: RADIUS_DEFAULT,
    start: '08:30',
    end: '18:00',
    mode: MODES.BOTH,
    workDays: [...WORK_DAYS],
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
  const needsTime = true;

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

  for (const field of ['entryRadius', 'exitRadius']) {
    const rErr = radiusError(v[field] ?? v.radius);
    if (rErr) errors[field] = rErr;
    else wp[field] = Number(String(v[field] ?? v.radius).trim());
  }
  delete wp.radius;

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

  wp.workDays = Array.isArray(v.workDays) ? [...new Set(v.workDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : [...WORK_DAYS];
  if (!wp.workDays.length) errors.workDays = 'En az bir çalışma günü seçin.';

  return { ok: Object.keys(errors).length === 0, errors, wp };
}

export function geoStatus(wp, pos, now) {
  if (!hasCoords(wp)) return { state: 'nocoords' };
  if (!pos) return { state: 'nodata' };
  const dist = distance(pos, { lat: wp.lat, lon: wp.lon });
  const inside = dist <= radiusFor(wp, 'entry');
  const exitInside = dist <= radiusFor(wp, 'exit');
  return {
    state: inside ? 'inside' : 'outside',
    inside,
    exitInside,
    distance: dist,
    accuracy: pos.accuracy,
    time: pos.time,
    stale: now - pos.time > GEO_FRESH_MS,
  };
}

// Attendance is never inferred or recorded. Only reminder delivery/dismissal is tracked.
export const alertTitle = (kind) => kind === 'entry' ? 'Giriş yapmayı unutma!' : 'Çıkış yapmayı unutma!';
export const alertBody = (kind) => kind === 'entry'
  ? 'İşe giriş işlemini kullandığınız sistemde tamamlamayı unutmayın.'
  : 'İşten çıkış işlemini kullandığınız sistemde tamamlamayı unutmayın.';
export const reminderId = (day, kind) => `etkinik-v2-${day}-${kind}`;
export const isWorkDay = (wp, now = new Date()) => (wp.workDays || WORK_DAYS).includes(now.getDay());
export const timeFor = (wp, kind, day = new Date()) => todayAt(kind === 'entry' ? wp.start : wp.end, day);
export const dayStatus = (state, now = new Date()) => state.days[dateKey(now)] || {};

export function canRemind(state, wp, kind, now = Date.now()) {
  if (!state.enabled || state.setupComplete === false || !isWorkDay(wp, new Date(now))) return false;
  const status = dayStatus(state, new Date(now))[kind];
  return !status;
}

export function locationWindow(wp, kind, now = Date.now()) {
  const minute = minutesOfDay(new Date(now));
  const shiftMinute = parseHHMM(kind === 'entry' ? wp.start : wp.end);
  const cutoff = kind === 'entry' ? 14 * 60 : 23 * 60 + 45;
  return shiftMinute != null && minute >= Math.max(0, shiftMinute - 60) && minute <= cutoff;
}

export function locationReminder(state, wp, event, now = Date.now()) {
  if (!usesLocation(wp.mode)) return null;
  const kind = event === 'enter' ? 'entry' : event === 'exit' ? 'exit' : null;
  if (!kind || !locationWindow(wp, kind, now) || !canRemind(state, wp, kind, now)) return null;
  if (kind === 'exit' && !dayStatus(state, new Date(now)).seenInside) return null;
  return kind;
}

// A foreground position is a sample, not an arrival/departure event.
// Establish a baseline first; only subsequent boundary changes may notify.
export function positionReminder(state, wp, pos, now = Date.now()) {
  if (!state.enabled || state.setupComplete === false || !usesLocation(wp.mode)) return null;
  const geo = geoStatus(wp, pos, now);
  if (geo.inside == null || geo.stale) return null;
  const key = dateKey(new Date(now));
  const day = state.days[key] ||= {};
  const previous = day.location?.workplaceId === wp.id ? day.location : {};
  const entered = previous.entryInside === false && geo.inside;
  const exited = previous.exitInside === true && !geo.exitInside;
  if (geo.inside && isWorkDay(wp, new Date(now))) day.seenInside = true;
  day.location = { workplaceId: wp.id, entryInside: geo.inside, exitInside: geo.exitInside };
  return (entered ? locationReminder(state, wp, 'enter', now) : null)
    || (exited ? locationReminder(state, wp, 'exit', now) : null);
}

export function foregroundReminder(state, wp, now = Date.now()) {
  if (!state.enabled || state.setupComplete === false || !isWorkDay(wp, new Date(now))) return null;
  const day = dayStatus(state, new Date(now));
  // A location event already delivered its reminder while in the background.
  for (const kind of ['exit', 'entry']) {
    if (kind === 'entry' && now >= timeFor(wp, 'exit', new Date(now))) continue;
    if (day[kind]?.delivered && !day[kind]?.dismissed) return kind;
  }
  if (!usesTime(wp.mode)) return null;
  const start = timeFor(wp, 'entry', new Date(now));
  const end = timeFor(wp, 'exit', new Date(now));
  if (end != null && now >= end && canRemind(state, wp, 'exit', now)) return 'exit';
  if (start != null && now >= start && now < end && canRemind(state, wp, 'entry', now)) return 'entry';
  return null;
}

export function markReminder(state, kind, now = Date.now(), dismissed = false) {
  const key = dateKey(new Date(now));
  if (!state.days[key]) state.days[key] = {};
  state.days[key][kind] = { ...state.days[key][kind], delivered: now, dismissed };
  return state;
}

// Legacy single-radius settings retain their previous boundary for both reminders.
export const radiusFor = (wp, kind) => wp[`${kind}Radius`] ?? wp.radius ?? RADIUS_DEFAULT;
export const regionId = (wp, kind) => `${wp.id}:${kind}`;
export function workplaceRegions(wp) {
  return ['entry', 'exit'].map((kind) => ({
    identifier: regionId(wp, kind), latitude: wp.lat, longitude: wp.lon,
    radius: radiusFor(wp, kind),
    // Observe both directions to detect a later re-entry/re-exit correctly.
    notifyOnEnter: true, notifyOnExit: true,
  }));
}
export function regionReminder(state, wp, identifier, entering, now = Date.now()) {
  if (!state.enabled || state.setupComplete === false || !usesLocation(wp.mode)) return null;
  const kind = identifier === regionId(wp, 'entry') ? 'entry' : identifier === regionId(wp, 'exit') ? 'exit' : null;
  if (!kind) return null;
  const key = dateKey(new Date(now));
  const day = state.days[key] ||= {};
  const previous = day.location?.workplaceId === wp.id ? day.location : { workplaceId: wp.id };
  const field = `${kind}Inside`;
  const duplicate = previous[field] === entering;
  day.location = { ...previous, [field]: entering };
  if (kind === 'entry' && entering && isWorkDay(wp, new Date(now))) day.seenInside = true;
  if (duplicate) return null;
  if (kind === 'entry' && entering) return locationReminder(state, wp, 'enter', now);
  if (kind === 'exit' && !entering) return locationReminder(state, wp, 'exit', now);
  return null;
}
