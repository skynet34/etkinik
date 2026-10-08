import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';

import {
  MODES, MODE_LABELS, REPEAT_OPTIONS, RADIUS_MIN, RADIUS_MAX,
  evaluate, exitMessage, entryMessage, fmtTime, fmtDistance, hasCoords,
  radiusError, usesLocation, validateWorkplace, newWorkplace,
} from './src/logic';
import {
  loadState, saveState, todayRecord, ensureToday, activeWorkplace, currentWorkplace,
} from './src/storage';
import {
  getPermissionSummary, requestNotificationPermission, requestLocationPermissions,
  scheduleTimeExitReminders, clearExitReminders, clearEntryReminders, syncGeofencing, isGeofencingActive,
} from './src/reminders';

const C = {
  bg: '#f5f7f9', card: '#ffffff', text: '#1a1f24', muted: '#5b6670', border: '#dde2e7',
  primary: '#1f5fbf', ok: '#1e7b46', warnBg: '#fff4e5', warnBorder: '#f0a020', warnText: '#6b3d00',
  infoBg: '#eef4fc', infoBorder: '#9fbbe6', error: '#b42318',
};

const confirm = (title, message, okText = 'Evet') =>
  new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Vazgeç', style: 'cancel', onPress: () => resolve(false) },
      { text: okText, onPress: () => resolve(true) },
    ])
  );

function geoErrorMessage(e) {
  if (e === 'denied') return 'Konum izni verilmedi. Ayarlar > Etkinik > Konum bölümünden izni açın.';
  if (e === 'services') return 'Konum servisleri kapalı. Ayarlar > Gizlilik ve Güvenlik > Konum Servisleri\'ni açın.';
  return 'Konum alınamadı. Açık bir alanda tekrar deneyin.';
}

async function readPosition() {
  if (!(await Location.hasServicesEnabledAsync())) throw 'services';
  let p = await Location.getForegroundPermissionsAsync();
  if (p.status !== 'granted') p = await Location.requestForegroundPermissionsAsync();
  if (p.status !== 'granted') throw 'denied';
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, time: Date.now() };
}

export default function Root() {
  return (
    <SafeAreaProvider>
      <App />
    </SafeAreaProvider>
  );
}

function App() {
  const [state, setState] = useState(null);
  const [view, setView] = useState('home');
  const [now, setNow] = useState(Date.now());
  const [perms, setPerms] = useState(null);
  const [geofence, setGeofence] = useState(false);
  const [checking, setChecking] = useState(false);
  const [geoError, setGeoError] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const stateRef = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const commit = useCallback(async (s) => {
    stateRef.current = s;
    setState({ ...s });
    await saveState(s);
  }, []);

  const refreshPerms = useCallback(async () => {
    setPerms(await getPermissionSummary());
    setGeofence(await isGeofencingActive());
  }, []);

  const checkLocation = useCallback(async ({ silent = false } = {}) => {
    const s = stateRef.current;
    if (!s) return;
    const wp = currentWorkplace(s);
    if (!hasCoords(wp)) {
      if (!silent) setGeoError('İş yeri konumu ayarlanmamış. Önce Ayarlar\'dan iş yeri konumunu kaydedin.');
      return;
    }
    setChecking(true);
    try {
      const pos = await readPosition();
      const fresh = await loadState(); // arka plan görevi değiştirmiş olabilir
      fresh.lastPos = pos;
      const rec = todayRecord(fresh);
      const ev = evaluate(fresh, currentWorkplace(fresh), rec, Date.now());
      if (rec && rec.entry && !rec.exit && ev.geo.state === 'inside') rec.seenInside = true;
      setGeoError(null);
      await commit(fresh);
    } catch (e) {
      if (!silent || e === 'denied' || e === 'services') setGeoError(geoErrorMessage(e));
    } finally {
      setChecking(false);
      setNow(Date.now());
    }
  }, [commit]);

  const onForeground = useCallback(async () => {
    const s = await loadState();
    stateRef.current = s;
    setState({ ...s });
    await refreshPerms();
    setNow(Date.now());
    const wp = currentWorkplace(s);
    const fg = await Location.getForegroundPermissionsAsync();
    if (usesLocation(wp.mode) && hasCoords(wp) && fg.status === 'granted') checkLocation({ silent: true });
  }, [refreshPerms, checkLocation]);

  useEffect(() => {
    onForeground();
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') onForeground(); });
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => { sub.remove(); clearInterval(t); };
  }, [onForeground]);

  if (!state) return <View style={[styles.flex, { backgroundColor: C.bg }]} />;

  /* ---------- Eylemler ---------- */

  const onEntry = async () => {
    const s = stateRef.current;
    const existing = todayRecord(s);
    if (existing && existing.entry) {
      const msg = existing.exit
        ? `Bugün giriş (${fmtTime(existing.entry)}) ve çıkış (${fmtTime(existing.exit)}) kayıtlı. Yeni giriş kaydedilirse çıkış kaydı silinir.`
        : `Giriş zaten ${fmtTime(existing.entry)} olarak kaydedilmiş. Şimdi olarak güncellensin mi?`;
      if (!(await confirm('Giriş kaydı', msg, 'Güncelle'))) return;
    }
    const wp = activeWorkplace(s);
    const rec = ensureToday(s);
    rec.entry = Date.now();
    rec.exit = null;
    rec.workplaceId = wp.id;
    rec.seenInside = false;
    rec.leftAt = null;
    rec.backAt = null;
    const ev = evaluate(s, wp, rec, rec.entry);
    if (ev.geo.state === 'inside' && !ev.geo.stale) rec.seenInside = true;
    await commit(s);
    await clearEntryReminders();
    await clearExitReminders();
    const n = await scheduleTimeExitReminders(wp);
    showToast(`Giriş kaydedildi: ${fmtTime(rec.entry)}${n ? ` · ${wp.end} hatırlatması kuruldu` : ''}`);
    setGeofence((await syncGeofencing(s)).active);
    if (usesLocation(wp.mode) && hasCoords(wp)) checkLocation({ silent: true });
  };

  const onExit = async () => {
    const s = stateRef.current;
    const existing = todayRecord(s);
    if (!existing || !existing.entry) {
      if (!(await confirm('Giriş kaydı yok', 'Bugün için giriş kaydı yok. Yine de çıkış saati kaydedilsin mi?', 'Kaydet'))) return;
    } else if (existing.exit) {
      if (!(await confirm('Çıkış kaydı', `Çıkış zaten ${fmtTime(existing.exit)} olarak kaydedilmiş. Şimdi olarak güncellensin mi?`, 'Güncelle'))) return;
    }
    const rec = ensureToday(s);
    if (!rec.workplaceId) rec.workplaceId = activeWorkplace(s).id;
    rec.exit = Date.now();
    await commit(s);
    await clearExitReminders();
    showToast(`Çıkış kaydedildi: ${fmtTime(rec.exit)}`);
  };

  const askNotifications = async () => {
    await requestNotificationPermission();
    await refreshPerms();
  };

  const askLocation = async () => {
    if (perms && perms.locationAsked && !perms.locationAlways) {
      Linking.openSettings();
      return;
    }
    await requestLocationPermissions();
    setGeofence((await syncGeofencing(stateRef.current)).active);
    await refreshPerms();
  };

  /* ---------- Görünüm ---------- */

  const rec = todayRecord(state);
  const wp = currentWorkplace(state);
  const ev = evaluate(state, wp, rec, now);

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: C.bg }]} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={styles.topbar}>
        <Text style={styles.brand}>ETKİNİK</Text>
        <Pressable hitSlop={10} onPress={() => setView(view === 'home' ? 'settings' : 'home')}>
          <Text style={styles.link}>{view === 'home' ? 'Ayarlar' : '← Ana ekran'}</Text>
        </Pressable>
      </View>

      {view === 'home' ? (
        <Home
          ev={ev} wp={wp} rec={rec} perms={perms} geofence={geofence}
          checking={checking} geoError={geoError}
          onEntry={onEntry} onExit={onExit} onCheck={() => checkLocation()}
          onSettings={() => setView('settings')}
          onAskNotifications={askNotifications} onAskLocation={askLocation}
        />
      ) : (
        <Settings
          state={state}
          onChange={async (s, msg) => {
            await commit(s);
            const p = await getPermissionSummary();
            const awp = activeWorkplace(s);
            if (usesLocation(awp.mode) && hasCoords(awp) && !p.locationAlways) await requestLocationPermissions();
            if (!p.notificationsAsked) await requestNotificationPermission();
            const r = todayRecord(s);
            if (r && r.entry && !r.exit) await scheduleTimeExitReminders(currentWorkplace(s));
            setGeofence((await syncGeofencing(s)).active);
            await refreshPerms();
            if (msg) showToast(msg);
          }}
          onSaved={() => {
            setView('home');
            const awp = activeWorkplace(stateRef.current);
            if (usesLocation(awp.mode) && hasCoords(awp)) checkLocation({ silent: true });
          }}
        />
      )}

      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/* ===================== Ana ekran ===================== */

function Home({ ev, wp, rec, perms, geofence, checking, geoError, onEntry, onExit, onCheck, onSettings, onAskNotifications, onAskLocation }) {
  const { hasEntry, hasExit, geo } = ev;
  let status = 'Giriş yapılmadı';
  let statusStyle = null;
  let hint = 'İşe geldiğinizde İK uygulamanızda giriş yapın, ardından "Giriş yaptım"a basın.';
  if (hasEntry && !hasExit) { status = 'Çıkış yapılmadı'; statusStyle = styles.out; hint = 'İşten ayrılırken çıkış yapmayı unutma.'; }
  else if (hasEntry && hasExit) { status = 'Giriş ve çıkış kaydedildi'; statusStyle = styles.ok; hint = ''; }
  else if (hasExit) { status = 'Çıkış kaydedildi (giriş kaydı yok)'; hint = ''; }

  const dateText = new Date(ev.now).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
  const entryPrimary = !hasEntry;
  const needsAlways = usesLocation(wp.mode) && hasCoords(wp) && perms && !perms.locationAlways;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      {ev.exitDue ? (
        <View style={styles.alert}>
          <Text style={styles.alertTitle}>Çıkış yapmayı unutma!</Text>
          <Text style={styles.alertBody}>{exitMessage(ev)}</Text>
        </View>
      ) : ev.entryDue ? (
        <View style={[styles.alert, styles.alertEntry]}>
          <Text style={[styles.alertTitle, { color: '#163a70', fontSize: 18 }]}>Giriş yapmayı unutma!</Text>
          <Text style={[styles.alertBody, { color: '#163a70' }]}>{entryMessage(ev)}</Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <View style={styles.cardHead}>
          <Text style={styles.h2}>BUGÜN</Text>
          <Text style={styles.small}>{dateText}</Text>
        </View>
        <Text style={styles.small}>İş yeri: {wp.name} · {MODE_LABELS[wp.mode]}</Text>
        <View style={styles.times}>
          <View style={styles.timeBox}>
            <Text style={styles.label}>Giriş</Text>
            <Text style={styles.time}>{fmtTime(rec && rec.entry)}</Text>
          </View>
          <View style={styles.timeBox}>
            <Text style={styles.label}>Çıkış</Text>
            <Text style={styles.time}>{fmtTime(rec && rec.exit)}</Text>
          </View>
        </View>
        <Text style={[styles.status, statusStyle]}>{status}</Text>
        {hint ? <Text style={styles.muted}>{hint}</Text> : null}
      </View>

      <Btn title="Giriş yaptım" kind={entryPrimary ? 'primary' : 'secondary'} onPress={onEntry} />
      <Btn title="Çıkış yaptım" kind={entryPrimary ? 'secondary' : 'primary'} onPress={onExit} />

      {needsAlways ? (
        <View style={[styles.card, styles.warnCard]}>
          <Text style={styles.warnTitle}>Konum izni "Her Zaman" değil</Text>
          <Text style={styles.warnText}>
            Uygulama kapalıyken iş yerinden çıktığınızı algılayabilmesi için konum iznini "Her Zaman" yapın.
          </Text>
          <Btn
            title={perms.locationAsked ? 'Ayarları aç' : 'Konum izni ver'}
            kind="outline"
            onPress={onAskLocation}
          />
        </View>
      ) : null}

      {perms && !perms.notifications ? (
        <View style={[styles.card, styles.warnCard]}>
          <Text style={styles.warnTitle}>Bildirimler kapalı</Text>
          <Text style={styles.warnText}>Hatırlatmaların uygulama kapalıyken gelmesi için bildirim izni gerekli.</Text>
          <Btn
            title={perms.notificationsAsked ? 'Ayarları aç' : 'Bildirimlere izin ver'}
            kind="outline"
            onPress={perms.notificationsAsked ? () => Linking.openSettings() : onAskNotifications}
          />
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.h2}>Konum durumu</Text>
        <GeoStatus geo={geo} wp={wp} checking={checking} now={ev.now} />
        {usesLocation(wp.mode) && hasCoords(wp) ? (
          <Text style={[styles.small, { marginTop: 8 }]}>
            Arka plan takibi: {geofence ? 'açık' : 'kapalı'}
          </Text>
        ) : null}
        {geoError ? <Text style={styles.error}>{geoError}</Text> : null}
        {hasCoords(wp) ? (
          <Btn title={checking ? 'Konum alınıyor…' : 'Konumumu kontrol et'} kind="outline" onPress={onCheck} disabled={checking} />
        ) : usesLocation(wp.mode) ? (
          <Btn title="İş yeri konumunu ayarla" kind="outline" onPress={onSettings} />
        ) : null}
      </View>

      <Text style={[styles.small, styles.footnote]}>
        Etkinik yalnızca hatırlatır. Giriş/çıkış işlemini İK uygulamanızda kendiniz yapmalısınız.
      </Text>
    </ScrollView>
  );
}

function GeoStatus({ geo, wp, checking, now }) {
  if (geo.state === 'nocoords') {
    return (
      <Text style={styles.status}>
        {usesLocation(wp.mode) ? 'İş yeri konumu ayarlanmamış.' : 'Hatırlatma yöntemi "Yalnızca saat"; konum kullanılmıyor.'}
      </Text>
    );
  }
  if (geo.state === 'nodata') {
    return <Text style={styles.status}>{checking ? 'Konum alınıyor…' : 'Henüz konum kontrolü yapılmadı.'}</Text>;
  }
  const ago = Math.floor((now - geo.time) / 60000);
  const warns = [];
  if (geo.stale) warns.push('Son ölçüm eski; güncel durum için "Konumumu kontrol et"e basın.');
  if (geo.accuracy != null && geo.accuracy > wp.radius) {
    warns.push(`Konum hassasiyeti (±${Math.round(geo.accuracy)} m) kapsama alanından (${wp.radius} m) büyük; sonuç yanıltıcı olabilir.`);
  }
  return (
    <View>
      <Text style={[styles.status, geo.inside ? styles.ok : styles.out]}>
        {geo.inside ? 'İş yerindesiniz.' : 'İş yeri alanı dışındasınız.'}
      </Text>
      <View style={styles.kv}>
        <KV k="Mesafe" v={fmtDistance(geo.distance)} />
        <KV k="Alan" v={`${wp.radius} m`} />
        <KV k="Hassasiyet" v={geo.accuracy != null ? `±${Math.round(geo.accuracy)} m` : '—'} />
        <KV k="Son kontrol" v={ago < 1 ? 'az önce' : ago < 60 ? `${ago} dk önce` : fmtTime(geo.time)} />
      </View>
      {warns.length ? <Text style={[styles.warnText, { marginTop: 8 }]}>{warns.join(' ')}</Text> : null}
    </View>
  );
}

const KV = ({ k, v }) => (
  <View style={styles.kvItem}>
    <Text style={styles.kvKey}>{k}</Text>
    <Text style={styles.kvVal}>{v}</Text>
  </View>
);

function Btn({ title, kind = 'primary', onPress, disabled, small }) {
  const s = kind === 'primary' ? styles.btnPrimary : kind === 'secondary' ? styles.btnSecondary : styles.btnOutline;
  const t = kind === 'primary' ? styles.btnPrimaryText : kind === 'secondary' ? styles.btnSecondaryText : styles.btnOutlineText;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.btn, small && styles.btnSmall, s, (pressed || disabled) && { opacity: 0.7 }]}
    >
      <Text style={[styles.btnText, small && { fontSize: 15 }, t]}>{title}</Text>
    </Pressable>
  );
}

/* ===================== Ayarlar ===================== */

function formFrom(wp) {
  return {
    name: wp.name,
    lat: hasCoords(wp) ? wp.lat.toFixed(6) : '',
    lon: hasCoords(wp) ? wp.lon.toFixed(6) : '',
    radius: String(wp.radius),
    start: wp.start || '',
    end: wp.end || '',
    mode: wp.mode,
    repeat: wp.repeat,
  };
}

function Settings({ state, onChange, onSaved }) {
  const wp = activeWorkplace(state);
  const [form, setForm] = useState(formFrom(wp));
  const [errors, setErrors] = useState({});
  const [locMsg, setLocMsg] = useState(null);
  const [locBusy, setLocBusy] = useState(false);

  useEffect(() => { setForm(formFrom(activeWorkplace(state))); setErrors({}); setLocMsg(null); }, [state.activeId]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const rNum = Number(form.radius);
  const sliderVal = radiusError(form.radius) ? null : rNum;

  const useCurrent = async () => {
    setLocBusy(true);
    setLocMsg(null);
    try {
      const pos = await readPosition();
      setForm((f) => ({ ...f, lat: pos.lat.toFixed(6), lon: pos.lon.toFixed(6) }));
      setErrors((e) => ({ ...e, coords: null }));
      const r = sliderVal || 100;
      let t = `Konum alındı (hassasiyet ±${Math.round(pos.accuracy)} m). Kaydetmek için "Kaydet"e basın.`;
      if (pos.accuracy > r) t += ` Hassasiyet kapsama alanından (${r} m) büyük; açık alanda tekrar denemeniz önerilir.`;
      setLocMsg({ text: t, warn: pos.accuracy > r });
    } catch (e) {
      setLocMsg({ text: geoErrorMessage(e), error: true });
    } finally {
      setLocBusy(false);
    }
  };

  const save = async () => {
    const res = validateWorkplace(wp, form);
    setErrors(res.errors);
    if (!res.ok) return;
    const s = { ...state, workplaces: state.workplaces.map((w) => (w.id === res.wp.id ? res.wp : w)) };
    await onChange(s, 'Ayarlar kaydedildi.');
    onSaved();
  };

  const addWp = async () => {
    const n = newWorkplace(`İş Yeri ${state.workplaces.length + 1}`);
    await onChange({ ...state, workplaces: [...state.workplaces, n], activeId: n.id }, 'Yeni iş yeri eklendi. Ayarlarını yapıp kaydedin.');
  };

  const delWp = async () => {
    if (state.workplaces.length <= 1) return;
    if (!(await confirm('İş yerini sil', `"${wp.name}" silinsin mi?`, 'Sil'))) return;
    const rest = state.workplaces.filter((w) => w.id !== wp.id);
    await onChange({ ...state, workplaces: rest, activeId: rest[0].id }, 'İş yeri silindi.');
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.h2}>İş yerleri</Text>
        <Text style={styles.fieldLabel}>Aktif iş yeri</Text>
        <View style={styles.chips}>
          {state.workplaces.map((w) => (
            <Chip key={w.id} label={`${w.name} (${w.radius} m)`} selected={w.id === wp.id}
              onPress={() => onChange({ ...state, activeId: w.id })} />
          ))}
        </View>
        <View style={styles.row2}>
          <View style={styles.flex}><Btn small title="Yeni iş yeri ekle" kind="outline" onPress={addWp} /></View>
          <View style={styles.flex}>
            <Btn small title="Bu iş yerini sil" kind="outline" onPress={delWp} disabled={state.workplaces.length <= 1} />
          </View>
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.h2}>İş yeri ayarları</Text>

        <Text style={styles.fieldLabel}>İş yeri adı</Text>
        <TextInput style={[styles.input, errors.name && styles.invalid]} value={form.name} maxLength={40}
          onChangeText={(v) => set('name', v)} placeholder="Merkez Ofis" />
        <FieldError msg={errors.name} />

        <View style={styles.row2}>
          <View style={styles.flex}>
            <Text style={styles.fieldLabel}>Enlem</Text>
            <TextInput style={[styles.input, errors.coords && styles.invalid]} value={form.lat}
              onChangeText={(v) => set('lat', v)} keyboardType="numbers-and-punctuation" placeholder="41.008200" />
          </View>
          <View style={styles.flex}>
            <Text style={styles.fieldLabel}>Boylam</Text>
            <TextInput style={[styles.input, errors.coords && styles.invalid]} value={form.lon}
              onChangeText={(v) => set('lon', v)} keyboardType="numbers-and-punctuation" placeholder="28.978400" />
          </View>
        </View>
        <FieldError msg={errors.coords} />
        <Btn title={locBusy ? 'Konum alınıyor…' : 'Mevcut konumumu iş yeri yap'} kind="outline" onPress={useCurrent} disabled={locBusy} />
        {locMsg ? (
          <Text style={[styles.small, locMsg.warn && styles.warnText, locMsg.error && styles.error]}>{locMsg.text}</Text>
        ) : null}

        <Text style={styles.fieldLabel}>Kapsama alanı</Text>
        <View style={styles.radiusRow}>
          <TextInput
            style={[styles.input, styles.radiusInput, errors.radius && styles.invalid]}
            value={form.radius}
            keyboardType="number-pad"
            maxLength={3}
            onChangeText={(v) => { set('radius', v.replace(/[^0-9]/g, '')); setErrors((e) => ({ ...e, radius: null })); }}
            onBlur={() => setErrors((e) => ({ ...e, radius: radiusError(form.radius) }))}
          />
          <Text style={styles.unit}>m</Text>
        </View>
        <Slider
          style={{ height: 40, marginTop: 6 }}
          minimumValue={RADIUS_MIN}
          maximumValue={RADIUS_MAX}
          step={1}
          value={sliderVal ?? wp.radius}
          minimumTrackTintColor={C.primary}
          maximumTrackTintColor={C.border}
          onValueChange={(v) => { set('radius', String(Math.round(v))); setErrors((e) => ({ ...e, radius: null })); }}
        />
        <View style={styles.scale}><Text style={styles.small}>10 m</Text><Text style={styles.small}>300 m</Text></View>
        <FieldError msg={errors.radius} />

        <View style={styles.row2}>
          <View style={styles.flex}>
            <Text style={styles.fieldLabel}>Mesai başlangıcı</Text>
            <TextInput style={[styles.input, errors.hours && styles.invalid]} value={form.start} maxLength={5}
              onChangeText={(v) => set('start', v)} keyboardType="numbers-and-punctuation" placeholder="08:30" />
          </View>
          <View style={styles.flex}>
            <Text style={styles.fieldLabel}>Mesai bitişi</Text>
            <TextInput style={[styles.input, errors.hours && styles.invalid]} value={form.end} maxLength={5}
              onChangeText={(v) => set('end', v)} keyboardType="numbers-and-punctuation" placeholder="18:00" />
          </View>
        </View>
        <FieldError msg={errors.hours} />

        <Text style={styles.fieldLabel}>Hatırlatma yöntemi</Text>
        {[MODES.LOCATION, MODES.TIME, MODES.BOTH].map((m) => (
          <Pressable key={m} onPress={() => set('mode', m)} style={[styles.radio, form.mode === m && styles.radioOn]}>
            <View style={[styles.radioDot, form.mode === m && styles.radioDotOn]} />
            <Text style={styles.radioText}>{MODE_LABELS[m]}</Text>
          </Pressable>
        ))}

        <Text style={styles.fieldLabel}>Tekrar hatırlatma</Text>
        <View style={styles.chips}>
          {REPEAT_OPTIONS.map((r) => (
            <Chip key={r} label={r === 0 ? 'Kapalı' : `${r} dk`} selected={form.repeat === r} onPress={() => set('repeat', r)} />
          ))}
        </View>

        <Btn title="Kaydet" onPress={save} />
        {Object.values(errors).some(Boolean) ? (
          <Text style={styles.error}>Kaydedilmedi. Lütfen işaretli alanları düzeltin.</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const FieldError = ({ msg }) => (msg ? <Text style={styles.fieldError}>{msg}</Text> : null);

const Chip = ({ label, selected, onPress }) => (
  <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipOn]}>
    <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
  </Pressable>
);

/* ===================== Stiller ===================== */

const styles = StyleSheet.create({
  flex: { flex: 1 },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  brand: { fontSize: 20, fontWeight: '700', letterSpacing: 1.6, color: C.text },
  link: { color: C.primary, fontSize: 16, fontWeight: '600' },
  scroll: { paddingHorizontal: 16, paddingBottom: 40 },
  card: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 16, marginBottom: 14 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  h2: { fontSize: 15, fontWeight: '700', letterSpacing: 0.5, color: C.muted, marginBottom: 6 },
  small: { fontSize: 14, color: C.muted },
  muted: { fontSize: 15, color: C.muted, marginTop: 4 },
  times: { flexDirection: 'row', gap: 12, marginVertical: 10 },
  timeBox: { flex: 1, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 12 },
  label: { fontSize: 14, color: C.muted },
  time: { fontSize: 32, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] },
  status: { fontSize: 17, fontWeight: '600', color: C.text, marginTop: 4 },
  ok: { color: C.ok },
  out: { color: C.warnText },
  alert: { borderWidth: 2, borderColor: C.warnBorder, backgroundColor: C.warnBg, borderRadius: 12, padding: 16, marginBottom: 14 },
  alertEntry: { borderWidth: 1, borderColor: C.infoBorder, backgroundColor: C.infoBg },
  alertTitle: { fontSize: 20, fontWeight: '700', color: C.warnText },
  alertBody: { fontSize: 16, color: C.warnText, marginTop: 6, lineHeight: 22 },
  warnCard: { backgroundColor: C.warnBg, borderColor: C.warnBorder },
  warnTitle: { fontSize: 16, fontWeight: '700', color: C.warnText },
  warnText: { fontSize: 14, color: C.warnText, marginTop: 4 },
  error: { color: C.error, fontSize: 15, marginTop: 8 },
  kv: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  kvItem: { width: '50%', marginBottom: 8 },
  kvKey: { fontSize: 13, color: C.muted },
  kvVal: { fontSize: 16, fontWeight: '600', color: C.text, fontVariant: ['tabular-nums'] },
  footnote: { textAlign: 'center', marginTop: 4 },
  btn: { minHeight: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, marginBottom: 10, borderWidth: 1 },
  btnSmall: { minHeight: 44, marginBottom: 0 },
  btnText: { fontSize: 18, fontWeight: '600' },
  btnPrimary: { backgroundColor: C.primary, borderColor: C.primary },
  btnPrimaryText: { color: '#fff' },
  btnSecondary: { backgroundColor: '#fff', borderColor: C.primary },
  btnSecondaryText: { color: C.primary },
  btnOutline: { backgroundColor: '#fff', borderColor: C.border, minHeight: 50, marginTop: 10 },
  btnOutlineText: { color: C.text, fontSize: 16 },
  fieldLabel: { fontSize: 14, color: C.muted, marginTop: 14, marginBottom: 4 },
  input: { minHeight: 48, borderWidth: 1, borderColor: C.border, borderRadius: 10, paddingHorizontal: 12, fontSize: 17, color: C.text, backgroundColor: '#fff' },
  invalid: { borderColor: C.error },
  fieldError: { color: C.error, fontSize: 14, marginTop: 4 },
  row2: { flexDirection: 'row', gap: 10, marginTop: 4 },
  radiusRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  radiusInput: { width: 110, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  unit: { fontSize: 18, fontWeight: '600', color: C.text },
  scale: { flexDirection: 'row', justifyContent: 'space-between' },
  radio: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 12, minHeight: 48, marginBottom: 6 },
  radioOn: { borderColor: C.primary },
  radioDot: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: C.border },
  radioDotOn: { borderColor: C.primary, borderWidth: 6 },
  radioText: { fontSize: 16, color: C.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { borderWidth: 1, borderColor: C.border, borderRadius: 20, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#fff' },
  chipOn: { borderColor: C.primary, backgroundColor: C.infoBg },
  chipText: { fontSize: 15, color: C.text },
  chipTextOn: { color: C.primary, fontWeight: '600' },
  toast: { position: 'absolute', left: 16, right: 16, bottom: 30, backgroundColor: '#1a1f24', borderRadius: 10, padding: 14 },
  toastText: { color: '#fff', fontSize: 15, textAlign: 'center' },
});
