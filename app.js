'use strict';
/*
 * Etkinik — giriş/çıkış hatırlatıcı (ilk PWA prototipi)
 *
 * Katmanlar:
 *   Store    : localStorage üzerinde ayarlar ve günlük kayıtlar
 *   Validate : form ve veri doğrulama
 *   Geo      : konum alma + mesafe hesabı      (native sürümde geofencing ile değiştirilecek)
 *   Engine   : hatırlatma kararları + zamanlayıcı (karar mantığı platformdan bağımsız)
 *   Notifier : sistem bildirimi + titreşim     (native sürümde yerel bildirim ile değiştirilecek)
 *   UI       : ekran
 *
 * Kural: Uygulama ASLA kendiliğinden giriş/çıkış kaydı oluşturmaz.
 * Kayıt yalnızca "Giriş yaptım" / "Çıkış yaptım" butonlarıyla oluşur.
 */

/* ===================== Sabitler ===================== */
const RADIUS_MIN = 10;
const RADIUS_MAX = 300;
const RADIUS_DEFAULT = 100;
const MODES = { LOCATION: 'location', TIME: 'time', BOTH: 'both' };
const MODE_LABELS = { location: 'Yalnızca konum', time: 'Yalnızca saat', both: 'Konum + saat' };
const REPEAT_OPTIONS = [0, 5, 10, 15, 30];
const STORAGE_KEY = 'etkinik.v1';
const TICK_MS = 30 * 1000;              // saat kontrolü sıklığı (uygulama açıkken)
const GEO_FRESH_MS = 10 * 60 * 1000;    // bu süreden eski konum ölçümü "güncel değil" sayılır
const AUTO_CHECK_MIN_GAP_MS = 60 * 1000;
const KEEP_DAYS = 90;

/* ===================== Yardımcılar ===================== */
const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTime = (ts) => { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const minutesOfDay = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = (id) => document.getElementById(id);

function parseHHMM(s) {
  if (!/^\d{2}:\d{2}$/.test(s || '')) return null;
  const [h, m] = s.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

function fmtDistance(m) {
  if (m == null || !isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

function fmtAgo(ts, now = Date.now()) {
  const min = Math.floor((now - ts) / 60000);
  if (min < 1) return 'az önce';
  if (min < 60) return `${min} dk önce`;
  return `${fmtTime(ts)}`;
}

function newWorkplace(name) {
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

/* ===================== Store ===================== */
const Store = {
  state: null,

  defaults() {
    return { version: 1, activeId: null, workplaces: [], days: {}, lastPos: null };
  },

  load() {
    let s;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      s = raw ? Object.assign(this.defaults(), JSON.parse(raw)) : this.defaults();
    } catch (e) {
      s = this.defaults();
    }
    if (!Array.isArray(s.workplaces)) s.workplaces = [];
    if (!s.days || typeof s.days !== 'object') s.days = {};
    this.state = s;
    if (!s.workplaces.length) {
      const wp = newWorkplace('Merkez Ofis');
      s.workplaces.push(wp);
      s.activeId = wp.id;
    }
    if (!this.getWorkplace(s.activeId)) s.activeId = s.workplaces[0].id;
    this.prune();
    this.save();
  },

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      return true;
    } catch (e) {
      UI.toast('Kayıt yapılamadı: tarayıcı depolaması kullanılamıyor (gizli sekme olabilir).');
      return false;
    }
  },

  prune() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
    const cutKey = dateKey(cutoff);
    Object.keys(this.state.days).forEach((k) => { if (k < cutKey) delete this.state.days[k]; });
  },

  getWorkplace(id) { return this.state.workplaces.find((w) => w.id === id) || null; },
  active() { return this.getWorkplace(this.state.activeId) || this.state.workplaces[0]; },
  setActive(id) { if (this.getWorkplace(id)) { this.state.activeId = id; this.save(); } },

  updateWorkplace(wp) {
    const i = this.state.workplaces.findIndex((w) => w.id === wp.id);
    if (i >= 0) this.state.workplaces[i] = wp; else this.state.workplaces.push(wp);
    this.save();
  },

  addWorkplace() {
    const wp = newWorkplace(`İş Yeri ${this.state.workplaces.length + 1}`);
    this.state.workplaces.push(wp);
    this.state.activeId = wp.id;
    this.save();
    return wp;
  },

  removeWorkplace(id) {
    if (this.state.workplaces.length <= 1) return false;
    this.state.workplaces = this.state.workplaces.filter((w) => w.id !== id);
    if (this.state.activeId === id) this.state.activeId = this.state.workplaces[0].id;
    this.save();
    return true;
  },

  todayRecord() { return this.state.days[dateKey()] || null; },
  ensureToday() {
    const k = dateKey();
    if (!this.state.days[k]) this.state.days[k] = {};
    return this.state.days[k];
  },

  setLastPos(pos) { this.state.lastPos = pos; this.save(); },
};

/* ===================== Validate ===================== */
const Validate = {
  hasCoords(wp) {
    return wp && typeof wp.lat === 'number' && typeof wp.lon === 'number' && isFinite(wp.lat) && isFinite(wp.lon);
  },

  parseCoord(str) {
    const s = String(str || '').trim().replace(',', '.');
    if (s === '') return { empty: true };
    if (!/^[-+]?\d{1,3}(\.\d+)?$/.test(s)) return { invalid: true };
    return { value: Number(s) };
  },

  /** Kapsama alanı: 10–300 arası tam sayı. Hata mesajı ya da null döner. */
  radiusError(str) {
    const s = String(str ?? '').trim();
    if (s === '') return 'Kapsama alanını girin (10–300 m).';
    if (!/^\d+$/.test(s)) return 'Kapsama alanı metre cinsinden tam sayı olmalı (ör. 58).';
    const n = Number(s);
    if (n < RADIUS_MIN) return `Kapsama alanı en az ${RADIUS_MIN} m olabilir.`;
    if (n > RADIUS_MAX) return `Kapsama alanı en fazla ${RADIUS_MAX} m olabilir.`;
    return null;
  },

  /** Form değerlerini doğrular. { ok, errors, wp } döner. */
  workplaceForm(base, v) {
    const errors = {};
    const wp = Object.assign({}, base);

    wp.name = (v.name || '').trim();
    if (!wp.name) errors.name = 'İş yeri adını girin.';

    wp.mode = Object.values(MODES).includes(v.mode) ? v.mode : MODES.BOTH;
    const needsLocation = wp.mode !== MODES.TIME;
    const needsTime = wp.mode !== MODES.LOCATION;

    const lat = this.parseCoord(v.lat);
    const lon = this.parseCoord(v.lon);
    if (lat.empty && lon.empty) {
      wp.lat = null; wp.lon = null;
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
      wp.lat = lat.value; wp.lon = lon.value;
    }

    const rErr = this.radiusError(v.radius);
    if (rErr) errors.radius = rErr; else wp.radius = Number(String(v.radius).trim());

    wp.start = v.start || '';
    wp.end = v.end || '';
    const sMin = parseHHMM(wp.start);
    const eMin = parseHHMM(wp.end);
    if (needsTime && sMin == null && eMin == null) errors.hours = 'Mesai saatleri girilmemiş. Başlangıç ve bitiş saatini girin.';
    else if (needsTime && sMin == null) errors.hours = 'Mesai başlangıç saatini girin.';
    else if (needsTime && eMin == null) errors.hours = 'Mesai bitiş saatini girin.';
    else if (sMin != null && eMin != null && eMin <= sMin) errors.hours = 'Mesai bitişi başlangıçtan sonra olmalı (gece vardiyası bu sürümde desteklenmiyor).';

    const rep = Number(v.repeat);
    wp.repeat = REPEAT_OPTIONS.includes(rep) ? rep : 10;

    return { ok: Object.keys(errors).length === 0, errors, wp };
  },
};

/* ===================== Geo ===================== */
const Geo = {
  watchId: null,

  supported() { return 'geolocation' in navigator; },

  getPosition() {
    return new Promise((resolve, reject) => {
      if (!window.isSecureContext) return reject({ code: 'insecure' });
      if (!this.supported()) return reject({ code: 'unsupported' });
      navigator.geolocation.getCurrentPosition(
        (p) => resolve(this.toPos(p)),
        (err) => reject({ code: err.code }),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  },

  /** Uygulama ekrandayken sürekli konum takibi. */
  startWatch(onPos, onErr) {
    if (this.watchId != null || !this.supported() || !window.isSecureContext) return;
    this.watchId = navigator.geolocation.watchPosition(
      (p) => onPos(this.toPos(p)),
      (err) => onErr && onErr({ code: err.code }),
      { enableHighAccuracy: true, timeout: 30000, maximumAge: 15000 }
    );
  },

  stopWatch() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
  },

  toPos(p) {
    return { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, time: Date.now() };
  },

  /** Haversine — metre */
  distance(a, b) {
    const R = 6371000;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  },

  errorMessage(err) {
    switch (err && err.code) {
      case 1: return 'Konum izni verilmedi. Telefon/tarayıcı ayarlarından bu site için konum iznini açıp tekrar deneyin.';
      case 2: return 'Konum alınamadı. GPS / konum servisleri kapalı olabilir; açıp tekrar deneyin.';
      case 3: return 'Konum zamanında alınamadı. Konum servislerinin açık olduğundan emin olup tekrar deneyin.';
      case 'insecure': return 'Konum yalnızca güvenli bağlantıda (https) çalışır. Uygulamayı https adresinden açın.';
      case 'unsupported': return 'Bu tarayıcı konum özelliğini desteklemiyor.';
      default: return 'Konum alınamadı. Lütfen tekrar deneyin.';
    }
  },
};

/* ===================== Notifier ===================== */
const Notifier = {
  supported() { return 'Notification' in window && 'serviceWorker' in navigator; },
  permission() { return 'Notification' in window ? Notification.permission : 'unsupported'; },

  async request() {
    if (!('Notification' in window)) return 'unsupported';
    try {
      const res = await Notification.requestPermission();
      if (res === 'granted') this.notify('Etkinik', 'Bildirimler açık. Hatırlatmalar burada görünecek.', 'etkinik-test');
      return res;
    } catch (e) {
      return Notification.permission;
    }
  },

  async notify(title, body, tag) {
    try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (e) { /* yok say */ }
    if (this.permission() !== 'granted') return false;
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      const opts = { body, tag, renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'tr' };
      if (reg) { await reg.showNotification(title, opts); return true; }
      new Notification(title, opts);
      return true;
    } catch (e) {
      return false;
    }
  },

  async clear(tags) {
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      if (!reg) return;
      const list = await reg.getNotifications();
      list.forEach((n) => { if (!tags || tags.includes(n.tag)) n.close(); });
    } catch (e) { /* yok say */ }
  },
};

/* ===================== Engine ===================== */
const Engine = {
  timer: null,

  usesLocation(mode) { return mode === MODES.LOCATION || mode === MODES.BOTH; },
  usesTime(mode) { return mode === MODES.TIME || mode === MODES.BOTH; },

  /** Bugünkü hatırlatmalar hangi iş yerine göre? Giriş yapılan iş yeri, yoksa aktif iş yeri. */
  currentWorkplace(rec) {
    return (rec && rec.workplaceId && Store.getWorkplace(rec.workplaceId)) || Store.active();
  },

  geoStatus(wp, pos, now) {
    if (!Validate.hasCoords(wp)) return { state: 'nocoords' };
    if (!pos) return { state: 'nodata' };
    const distance = Geo.distance(pos, { lat: wp.lat, lon: wp.lon });
    const inside = distance <= wp.radius;
    return {
      state: inside ? 'inside' : 'outside',
      inside,
      distance,
      accuracy: pos.accuracy,
      time: pos.time,
      stale: now - pos.time > GEO_FRESH_MS,
    };
  },

  /** Saf karar fonksiyonu: hiçbir kayıt oluşturmaz, yalnızca durumu hesaplar. */
  evaluate(now = Date.now()) {
    const rec = Store.todayRecord();
    const wp = this.currentWorkplace(rec);
    const pos = Store.state.lastPos;
    const geo = this.geoStatus(wp, pos, now);
    const nowMin = minutesOfDay(new Date(now));
    const startMin = parseHHMM(wp.start);
    const endMin = parseHHMM(wp.end);
    const hasEntry = !!(rec && rec.entry);
    const hasExit = !!(rec && rec.exit);
    const exitReasons = [];
    const entryReasons = [];

    if (hasEntry && !hasExit) {
      // Konum: giriş sonrası alan içinde görülmüş, giriş sonrası alınan son ölçüm alan dışında
      if (this.usesLocation(wp.mode) && rec.seenInside && geo.state === 'outside' && pos.time > rec.entry) {
        exitReasons.push('location');
      }
      // Saat: mesai bitişi geldi
      if (this.usesTime(wp.mode) && endMin != null && nowMin >= endMin) {
        exitReasons.push('time');
      }
    }

    if (!hasEntry && !hasExit) {
      if (this.usesLocation(wp.mode) && geo.state === 'inside' && !geo.stale) entryReasons.push('location');
      if (this.usesTime(wp.mode) && startMin != null && endMin != null && nowMin >= startMin && nowMin < endMin) entryReasons.push('time');
    }

    return {
      now, rec, wp, geo, hasEntry, hasExit,
      exitReasons, entryReasons,
      exitDue: exitReasons.length > 0,
      entryDue: entryReasons.length > 0,
    };
  },

  exitMessage(ev) {
    const lines = ['Çıkış yapılmadı.'];
    if (ev.exitReasons.includes('location')) lines.push('İş yerinden ayrılmış görünüyorsunuz.');
    if (ev.exitReasons.includes('time')) lines.push(`Mesai bitiş saati (${ev.wp.end}) geldi.`);
    lines.push("Kolay İK'da çıkış yapmayı unutma.");
    return lines.join('\n');
  },

  entryMessage(ev) {
    const lines = [];
    if (ev.entryReasons.includes('location')) lines.push(`${ev.wp.name} alanındasınız.`);
    if (ev.entryReasons.includes('time')) lines.push(`Mesai ${ev.wp.start}'da başladı.`);
    lines.push("Kolay İK'da giriş yaptıysanız \"Giriş yaptım\"a basın.");
    return lines.join('\n');
  },

  /** Konum bilgisi geldiğinde: giriş sonrası alan içinde görüldüyse işaretle (çıkış uyarısının ön koşulu). */
  onPosition(pos) {
    Store.state.lastPos = pos;
    const rec = Store.todayRecord();
    if (rec && rec.entry && !rec.exit) {
      const wp = this.currentWorkplace(rec);
      const g = this.geoStatus(wp, pos, Date.now());
      if (g.state === 'inside') rec.seenInside = true;
    }
    Store.save();
    this.tick();
  },

  maybeNotify(ev) {
    if (ev.exitDue) {
      const rec = ev.rec;
      const last = rec.exitNotifiedAt || 0;
      const interval = (ev.wp.repeat || 0) * 60000;
      if (!last || (interval > 0 && ev.now - last >= interval)) {
        rec.exitNotifiedAt = ev.now;
        Store.save();
        Notifier.notify('Çıkış yapmayı unutma!', this.exitMessage(ev).replace(/\n/g, ' '), 'etkinik-exit');
      }
    } else if (ev.entryDue && ev.entryReasons.includes('location')) {
      // Konumla tespit edilen giriş hatırlatması günde bir kez bildirilir
      const rec = Store.ensureToday();
      if (!rec.entryNotified) {
        rec.entryNotified = true;
        Store.save();
        Notifier.notify('Giriş yapmayı unutma!', this.entryMessage(ev).replace(/\n/g, ' '), 'etkinik-entry');
      }
    }
  },

  tick() {
    const ev = this.evaluate();
    UI.render(ev);
    this.maybeNotify(ev);
  },

  start() {
    this.tick();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  },
};

/* ===================== UI ===================== */
const UI = {
  view: 'home',
  toastTimer: null,
  checking: false,

  init() {
    $('navBtn').addEventListener('click', () => this.show(this.view === 'home' ? 'settings' : 'home'));
    $('btnGoSettings').addEventListener('click', () => this.show('settings'));
    $('btnEntry').addEventListener('click', () => this.onEntry());
    $('btnExit').addEventListener('click', () => this.onExit());
    $('btnCheck').addEventListener('click', () => this.checkLocation());
    $('btnNotify').addEventListener('click', async () => { await Notifier.request(); this.renderNotify(); });

    // Ayarlar
    $('wpSelect').addEventListener('change', (e) => { Store.setActive(e.target.value); this.fillForm(); Engine.tick(); });
    $('btnAddWp').addEventListener('click', () => { Store.addWorkplace(); this.fillForm(); Engine.tick(); this.toast('Yeni iş yeri eklendi. Ayarlarını yapıp kaydedin.'); });
    $('btnDelWp').addEventListener('click', () => this.onDeleteWorkplace());
    $('btnUseLoc').addEventListener('click', () => this.onUseCurrentLocation());
    $('wpForm').addEventListener('submit', (e) => { e.preventDefault(); this.onSave(); });

    // Kapsama alanı: sayı ⇄ slider
    const num = $('fRadius');
    const range = $('fRadiusRange');
    range.addEventListener('input', () => { num.value = range.value; this.setFieldError('radius', null); num.classList.remove('invalid'); });
    num.addEventListener('input', () => {
      const err = Validate.radiusError(num.value);
      if (!err) { range.value = String(Number(num.value)); this.setFieldError('radius', null); num.classList.remove('invalid'); }
      else if (num.value.trim() !== '') { this.setFieldError('radius', err); num.classList.add('invalid'); }
    });
    num.addEventListener('blur', () => {
      const err = Validate.radiusError(num.value);
      this.setFieldError('radius', err);
      num.classList.toggle('invalid', !!err);
    });
  },

  show(view) {
    this.view = view;
    $('viewHome').hidden = view !== 'home';
    $('viewSettings').hidden = view !== 'settings';
    $('navBtn').textContent = view === 'home' ? 'Ayarlar' : '← Ana ekran';
    if (view === 'settings') this.fillForm();
    else Engine.tick();
    window.scrollTo(0, 0);
  },

  toast(msg, ms = 3200) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  },

  /* ---------- Ana ekran ---------- */
  render(ev) {
    const { rec, wp, geo, hasEntry, hasExit } = ev;

    $('todayDate').textContent = new Date(ev.now).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
    $('wpLabel').textContent = `İş yeri: ${wp.name} · ${MODE_LABELS[wp.mode]}`;
    $('entryTime').textContent = fmtTime(rec && rec.entry);
    $('exitTime').textContent = fmtTime(rec && rec.exit);

    const status = $('dayStatus');
    const hint = $('dayHint');
    status.className = 'status';
    if (!hasEntry && !hasExit) {
      status.textContent = 'Giriş yapılmadı';
      hint.textContent = "İşe geldiğinizde Kolay İK'da giriş yapın, ardından \"Giriş yaptım\"a basın.";
    } else if (hasEntry && !hasExit) {
      status.textContent = 'Çıkış yapılmadı';
      status.classList.add('out');
      hint.textContent = 'İşten ayrılırken çıkış yapmayı unutma.';
    } else if (hasEntry && hasExit) {
      status.textContent = 'Giriş ve çıkış kaydedildi';
      status.classList.add('ok');
      hint.textContent = '';
    } else {
      status.textContent = 'Çıkış kaydedildi (giriş kaydı yok)';
      hint.textContent = '';
    }

    // Hangi buton öne çıksın
    const entryPrimary = !hasEntry;
    $('btnEntry').className = 'btn ' + (entryPrimary ? 'btn-primary' : 'btn-secondary');
    $('btnExit').className = 'btn ' + (entryPrimary ? 'btn-secondary' : 'btn-primary');

    // Uyarı kutusu
    const box = $('alertBox');
    if (ev.exitDue) {
      box.className = 'alert';
      $('alertTitle').textContent = 'Çıkış yapmayı unutma!';
      $('alertBody').textContent = Engine.exitMessage(ev);
      box.hidden = false;
    } else if (ev.entryDue) {
      box.className = 'alert entry';
      $('alertTitle').textContent = 'Giriş yapmayı unutma!';
      $('alertBody').textContent = Engine.entryMessage(ev);
      box.hidden = false;
    } else {
      box.hidden = true;
    }

    this.renderGeo(wp, geo, ev.now);
    this.renderNotify();
    document.title = ev.exitDue ? '⚠ Çıkış yapmayı unutma! — Etkinik' : 'Etkinik';
  },

  renderGeo(wp, geo, now) {
    const st = $('geoStatus');
    const details = $('geoDetails');
    const warn = $('geoWarn');
    st.className = 'status';
    warn.hidden = true;
    $('btnGoSettings').hidden = true;
    $('btnCheck').hidden = false;

    $('geoRadius').textContent = `${wp.radius} m`;

    if (geo.state === 'nocoords') {
      st.textContent = 'İş yeri konumu ayarlanmamış.';
      details.hidden = true;
      if (Engine.usesLocation(wp.mode)) {
        $('btnGoSettings').hidden = false;
        $('btnCheck').hidden = true;
      } else {
        st.textContent = 'Hatırlatma yöntemi "Yalnızca saat"; konum kullanılmıyor.';
        $('btnCheck').hidden = true;
      }
      return;
    }

    details.hidden = false;
    if (geo.state === 'nodata') {
      st.textContent = this.checking ? 'Konum alınıyor…' : 'Henüz konum kontrolü yapılmadı.';
      $('geoDistance').textContent = '—';
      $('geoAccuracy').textContent = '—';
      $('geoTime').textContent = '—';
      return;
    }

    if (geo.inside) { st.textContent = 'İş yerindesiniz.'; st.classList.add('ok'); }
    else { st.textContent = 'İş yeri alanı dışındasınız.'; st.classList.add('out'); }
    if (this.checking) st.textContent += ' (güncelleniyor…)';

    $('geoDistance').textContent = fmtDistance(geo.distance);
    $('geoAccuracy').textContent = geo.accuracy != null ? `±${Math.round(geo.accuracy)} m` : '—';
    $('geoTime').textContent = fmtAgo(geo.time, now);

    const warns = [];
    if (geo.stale) warns.push('Son konum ölçümü eski. Güncel durum için "Konumumu kontrol et"e basın.');
    if (geo.accuracy != null && geo.accuracy > wp.radius) {
      warns.push(`Konum hassasiyeti (±${Math.round(geo.accuracy)} m) kapsama alanından (${wp.radius} m) büyük; sonuç yanıltıcı olabilir.`);
    }
    if (warns.length) { warn.textContent = warns.join(' '); warn.hidden = false; }
  },

  renderNotify() {
    const card = $('notifyCard');
    const text = $('notifyText');
    const btn = $('btnNotify');
    const perm = Notifier.permission();
    btn.hidden = true;
    if (perm === 'granted') { card.hidden = true; return; }
    card.hidden = false;
    if (perm === 'unsupported' || !Notifier.supported()) {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      text.textContent = ios
        ? 'iPhone\'da bildirimler yalnızca uygulama ana ekrana eklenip oradan açıldığında kullanılabilir (iOS 16.4+). Şu an hatırlatmalar yalnızca ekranda görünür.'
        : 'Bu tarayıcı bildirimleri desteklemiyor. Hatırlatmalar yalnızca uygulama açıkken ekranda görünür.';
    } else if (perm === 'denied') {
      text.textContent = 'Bildirimler engellenmiş. Hatırlatmalar yalnızca uygulama açıkken ekranda görünür. İzni telefon/tarayıcı ayarlarından açabilirsiniz.';
    } else {
      text.textContent = 'Uygulama açıkken arka planda kaldığında da uyarı alabilmek için bildirimlere izin verin.';
      btn.hidden = false;
    }
  },

  async checkLocation(opts = {}) {
    const wp = Engine.currentWorkplace(Store.todayRecord());
    const errEl = $('geoError');
    if (!Validate.hasCoords(wp)) {
      if (!opts.silent) { errEl.textContent = 'İş yeri konumu ayarlanmamış. Önce Ayarlar\'dan iş yeri konumunu kaydedin.'; errEl.hidden = false; }
      return;
    }
    if (this.checking) return;
    this.checking = true;
    const btn = $('btnCheck');
    btn.disabled = true;
    btn.textContent = 'Konum alınıyor…';
    Engine.tick();
    try {
      const pos = await Geo.getPosition();
      errEl.hidden = true;
      this.checking = false;
      Engine.onPosition(pos);
    } catch (err) {
      this.checking = false;
      errEl.textContent = Geo.errorMessage(err);
      errEl.hidden = false;
      Engine.tick();
    } finally {
      btn.disabled = false;
      btn.textContent = 'Konumumu kontrol et';
    }
  },

  onEntry() {
    const existing = Store.todayRecord();
    if (existing && existing.entry) {
      const msg = existing.exit
        ? `Bugün giriş (${fmtTime(existing.entry)}) ve çıkış (${fmtTime(existing.exit)}) kayıtlı. Yeni giriş kaydedilirse çıkış kaydı silinir. Devam edilsin mi?`
        : `Giriş zaten ${fmtTime(existing.entry)} olarak kaydedilmiş. Giriş saati şimdi olarak güncellensin mi?`;
      if (!confirm(msg)) return;
    }
    const wp = Store.active();
    const rec = Store.ensureToday();
    rec.entry = Date.now();
    rec.exit = null;
    rec.workplaceId = wp.id;
    rec.exitNotifiedAt = null;
    rec.seenInside = false;
    const g = Engine.geoStatus(wp, Store.state.lastPos, rec.entry);
    if (g.state === 'inside' && !g.stale) rec.seenInside = true;
    Store.save();
    Notifier.clear(['etkinik-entry']);
    this.toast(`Giriş kaydedildi: ${fmtTime(rec.entry)}`);
    Engine.tick();
    // Alan içinde olduğunu doğrulamak için konumu sessizce kontrol et
    if (Engine.usesLocation(wp.mode) && Validate.hasCoords(wp)) this.checkLocation({ silent: true });
  },

  onExit() {
    const existing = Store.todayRecord();
    if (!existing || !existing.entry) {
      if (!confirm('Bugün için giriş kaydı yok. Yine de çıkış saati kaydedilsin mi?')) return;
    } else if (existing.exit) {
      if (!confirm(`Çıkış zaten ${fmtTime(existing.exit)} olarak kaydedilmiş. Şimdi olarak güncellensin mi?`)) return;
    }
    const rec = Store.ensureToday();
    if (!rec.workplaceId) rec.workplaceId = Store.active().id;
    rec.exit = Date.now();
    Store.save();
    Notifier.clear(['etkinik-exit', 'etkinik-entry']);
    this.toast(`Çıkış kaydedildi: ${fmtTime(rec.exit)}`);
    Engine.tick();
  },

  /* ---------- Ayarlar ---------- */
  fillForm() {
    const sel = $('wpSelect');
    sel.innerHTML = '';
    Store.state.workplaces.forEach((w) => {
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = `${w.name} (${w.radius} m)`;
      sel.appendChild(o);
    });
    const wp = Store.active();
    sel.value = wp.id;
    $('btnDelWp').disabled = Store.state.workplaces.length <= 1;

    $('fName').value = wp.name;
    $('fLat').value = Validate.hasCoords(wp) ? wp.lat.toFixed(6) : '';
    $('fLon').value = Validate.hasCoords(wp) ? wp.lon.toFixed(6) : '';
    $('fRadius').value = String(wp.radius);
    $('fRadiusRange').value = String(wp.radius);
    $('fStart').value = wp.start || '';
    $('fEnd').value = wp.end || '';
    document.querySelectorAll('input[name="fMode"]').forEach((r) => { r.checked = r.value === wp.mode; });
    $('fRepeat').value = String(wp.repeat);
    $('useLocMsg').hidden = true;
    $('formMsg').hidden = true;
    ['name', 'coords', 'radius', 'hours'].forEach((f) => this.setFieldError(f, null));
    ['fName', 'fLat', 'fLon', 'fRadius'].forEach((id) => $(id).classList.remove('invalid'));
  },

  setFieldError(field, msg) {
    const el = document.querySelector(`.field-error[data-for="${field}"]`);
    if (el) el.textContent = msg || '';
  },

  readForm() {
    const mode = document.querySelector('input[name="fMode"]:checked');
    return {
      name: $('fName').value,
      lat: $('fLat').value,
      lon: $('fLon').value,
      radius: $('fRadius').value,
      start: $('fStart').value,
      end: $('fEnd').value,
      mode: mode ? mode.value : MODES.BOTH,
      repeat: $('fRepeat').value,
    };
  },

  onSave() {
    const base = Store.active();
    const res = Validate.workplaceForm(base, this.readForm());
    this.setFieldError('name', res.errors.name);
    this.setFieldError('coords', res.errors.coords);
    this.setFieldError('radius', res.errors.radius);
    this.setFieldError('hours', res.errors.hours);
    $('fName').classList.toggle('invalid', !!res.errors.name);
    $('fLat').classList.toggle('invalid', !!res.errors.coords);
    $('fLon').classList.toggle('invalid', !!res.errors.coords);
    $('fRadius').classList.toggle('invalid', !!res.errors.radius);
    const msg = $('formMsg');
    if (!res.ok) {
      msg.textContent = 'Kaydedilmedi. Lütfen işaretli alanları düzeltin.';
      msg.hidden = false;
      return;
    }
    msg.hidden = true;
    Store.updateWorkplace(res.wp);
    this.toast('Ayarlar kaydedildi.');
    this.show('home');
    if (Engine.usesLocation(res.wp.mode) && Validate.hasCoords(res.wp)) this.checkLocation({ silent: true });
  },

  async onUseCurrentLocation() {
    const btn = $('btnUseLoc');
    const msg = $('useLocMsg');
    btn.disabled = true;
    btn.textContent = 'Konum alınıyor…';
    msg.hidden = true;
    try {
      const pos = await Geo.getPosition();
      $('fLat').value = pos.lat.toFixed(6);
      $('fLon').value = pos.lon.toFixed(6);
      this.setFieldError('coords', null);
      $('fLat').classList.remove('invalid');
      $('fLon').classList.remove('invalid');
      const r = Number($('fRadius').value) || RADIUS_DEFAULT;
      let t = `Konum alındı (hassasiyet ±${Math.round(pos.accuracy)} m). Kaydetmek için "Kaydet"e basın.`;
      if (pos.accuracy > r) t += ` Not: hassasiyet kapsama alanından (${r} m) büyük; açık alanda tekrar denemeniz önerilir.`;
      msg.textContent = t;
      msg.className = 'small ' + (pos.accuracy > r ? 'warn' : 'muted');
      msg.hidden = false;
    } catch (err) {
      msg.textContent = Geo.errorMessage(err);
      msg.className = 'small error';
      msg.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Mevcut konumumu iş yeri yap';
    }
  },

  onDeleteWorkplace() {
    const wp = Store.active();
    if (Store.state.workplaces.length <= 1) { this.toast('En az bir iş yeri olmalı.'); return; }
    if (!confirm(`"${wp.name}" silinsin mi?`)) return;
    Store.removeWorkplace(wp.id);
    this.fillForm();
    Engine.tick();
    this.toast('İş yeri silindi.');
  },
};

/* ===================== Uygulama yaşam döngüsü ===================== */
const App = {
  lastAutoCheck: 0,

  /** Uygulama açıldığında / öne geldiğinde konum kontrolü ve takibi */
  onForeground() {
    Engine.tick();
    const wp = Engine.currentWorkplace(Store.todayRecord());
    if (!Engine.usesLocation(wp.mode) || !Validate.hasCoords(wp)) return;
    if (Date.now() - this.lastAutoCheck > AUTO_CHECK_MIN_GAP_MS) {
      this.lastAutoCheck = Date.now();
      UI.checkLocation({ silent: true });
    }
    Geo.startWatch(
      (pos) => Engine.onPosition(pos),
      () => Geo.stopWatch()
    );
  },

  onBackground() {
    Geo.stopWatch();
  },

  init() {
    Store.load();
    UI.init();
    Engine.start();
    this.onForeground();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.onForeground();
      else this.onBackground();
    });
    window.addEventListener('pageshow', (e) => { if (e.persisted) this.onForeground(); });

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => { /* çevrimdışı önbellek olmadan da çalışır */ });
    }
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
