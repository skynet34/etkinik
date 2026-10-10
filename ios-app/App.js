import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, Vibration, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Slider from '@react-native-community/slider';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { MODES, MODE_LABELS, RADIUS_MIN, RADIUS_MAX, alertBody, alertTitle, dateKey, foregroundReminder,
  hasCoords, positionReminder, markReminder, radiusError, radiusFor, usesLocation, usesTime, validateWorkplace, newWorkplace } from './src/logic';
import { activeWorkplace, loadState, saveState } from './src/storage';
import { serialize } from './src/operations';
import { cancelTodayTime, dismissReminder, getPermissionSummary, isGeofencingActive, requestLocationPermissions,
  requestNotificationPermission, syncReminders } from './src/reminders';

const DAY_LABELS = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
const C = { bg: '#f5f7f9', card: '#fff', text: '#1a1f24', muted: '#5b6670', border: '#dde2e7', primary: '#1f5fbf',
  ok: '#1e7b46', warnBg: '#fff4e5', warnBorder: '#f0a020', warnText: '#6b3d00', infoBg: '#eef4fc', infoBorder: '#9fbbe6', error: '#b42318' };
const confirm = (title, message, okText = 'Evet') => new Promise((resolve) => Alert.alert(title, message,
  [{ text: 'Vazgeç', style: 'cancel', onPress: () => resolve(false) }, { text: okText, onPress: () => resolve(true) }]));
function geoErrorMessage(e) {
  if (e === 'denied') return 'Konum izni verilmedi. Telefon ayarlarından EtkinIK için konum iznini açın.';
  if (e === 'services') return 'Telefonun konum servisleri kapalı.';
  return 'Konum alınamadı. Açık bir alanda tekrar deneyin.';
}
async function readPosition() {
  if (!(await Location.hasServicesEnabledAsync())) throw 'services';
  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status !== 'granted') permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== 'granted') throw 'denied';
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy, time: Date.now() };
}
export default function Root() { return <SafeAreaProvider><App /></SafeAreaProvider>; }

function App() {
  const [state, setState] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [perms, setPerms] = useState(null);
  const [geofence, setGeofence] = useState(false);
  const [reminder, setReminder] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(null);
  const running = useRef(false);
  const reminderRef = useRef(null);
  const commit = useCallback(async (next) => { await saveState(next); stateRef.current = next; setState({ ...next }); }, []);

  const showReminder = useCallback(async (next, kind) => {
    const day = dateKey();
    const token = `${day}-${kind}`;
    if (reminderRef.current?.token === token) return;
    markReminder(next, kind);
    await commit(next);
    await cancelTodayTime(kind);
    reminderRef.current = { kind, token, day };
    setReminder(reminderRef.current);
    Vibration.vibrate([0, 250, 100, 250]);
  }, [commit]);

  const refresh = useCallback(async (rebuild = false) => {
    if (running.current) return;
    running.current = true;
    return serialize(async () => {
    try {
      const next = await loadState();
      const permission = await getPermissionSummary();
      setPerms(permission);
      const wp = activeWorkplace(next);
      // Reconcile local notifications received while the app was in the background.
      const presented = await Notifications.getPresentedNotificationsAsync();
      for (const item of presented) {
        const data = item.request.content.data;
        if (data?.day === dateKey() && ['entry', 'exit'].includes(data.kind) && !next.days[data.day]?.[data.kind]) markReminder(next, data.kind);
      }
      let kind = foregroundReminder(next, wp);
      if (next.enabled && usesLocation(wp.mode) && hasCoords(wp) && permission.locationForeground) {
        try {
          const pos = await readPosition();
          next.lastPos = pos;
          const locationKind = positionReminder(next, wp, pos);
          if (!kind) kind = locationKind;
        } catch { /* Location modes cannot notify without a location event. */ }
      }
      if (kind) await showReminder(next, kind);
      else {
        await commit(next);
        if (!next.enabled || reminderRef.current?.day !== dateKey()) { reminderRef.current = null; setReminder(null); }
      }
      if (rebuild) { const result = await syncReminders(next); setGeofence(result.active); }
      else setGeofence(await isGeofencingActive());
    } catch { setError('Hatırlatmalar hazırlanamadı. İzinleri kontrol edip tekrar deneyin.'); }
    finally { running.current = false; }
    });
  }, [commit, showReminder]);

  useEffect(() => {
    refresh(true);
    const foreground = AppState.addEventListener('change', (value) => { if (value === 'active') refresh(true); });
    const received = Notifications.addNotificationReceivedListener(() => { if (AppState.currentState === 'active') refresh(); });
    const opened = Notifications.addNotificationResponseReceivedListener(() => refresh());
    const timer = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 15000);
    return () => { foreground.remove(); received.remove(); opened.remove(); clearInterval(timer); };
  }, [refresh]);

  const dismiss = () => serialize(async () => {
    const current = reminderRef.current;
    if (!current) return;
    try {
      const next = await loadState();
      markReminder(next, current.kind, Date.now(), true);
      await commit(next);
      await cancelTodayTime(current.kind);
      await dismissReminder(current.kind, current.day);
      reminderRef.current = null; setReminder(null);
    } catch { setError('Uyarı kapatılamadı. Tekrar dokunun.'); }
  });
  const apply = async (next) => serialize(async () => {
    setBusy(true); setError(null);
    try {
      const latest = await loadState();
      next = { ...latest, ...next, days: latest.days, timeSchedule: latest.timeSchedule, geofenceSignature: latest.geofenceSignature };
      await commit(next);
      const result = await syncReminders(next);
      await commit(next);
      setGeofence(result.active);
      setPerms(await getPermissionSummary());
      if (!next.enabled) { reminderRef.current = null; setReminder(null); }
    } catch { setError('Ayarlar kaydedildi ancak hatırlatmalar hazırlanamadı. İzinleri kontrol edin.'); }
    finally { setBusy(false); }
  });
  const askNotifications = async () => { try { await requestNotificationPermission(); await refresh(true); } catch { setError('Bildirim izni alınamadı.'); } };
  const askLocation = async () => {
    try {
      if (perms?.locationAsked && !perms.locationAlways) { await Linking.openSettings(); return; }
      await requestLocationPermissions(); await refresh(true);
    } catch { setError('Konum izni alınamadı.'); }
  };
  if (!state) return <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}><Text style={{ padding: 24 }}>EtkinIK hazırlanıyor…</Text></SafeAreaView>;
  const wp = activeWorkplace(state);
  const locationConfigured = hasCoords(wp);
  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: C.bg }]} edges={['top', 'left', 'right', 'bottom']}>
      <StatusBar style="dark" />
      <View style={styles.topbar}>
        <Text style={styles.brand}>EtkinIK</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Ayarlar" hitSlop={12} onPress={() => setSettingsOpen(!settingsOpen)}>
          <Text style={styles.link}>{settingsOpen ? 'Kapat' : 'Ayarlar'}</Text>
        </Pressable>
      </View>
      {settingsOpen ? <Settings state={state} onChange={apply} onSaved={() => setSettingsOpen(false)} /> : (
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.card, { padding: 24 }]}>
            <Text style={[styles.small, { letterSpacing: 1.5 }]}>KİŞİSEL HATIRLATICINIZ</Text>
            <Text style={{ fontSize: 32, fontWeight: '700', color: C.text, marginTop: 14 }}>{state.enabled ? 'Aklınız işinizde kalsın.' : 'Hatırlatmalar duraklatıldı.'}</Text>
            <Text style={[styles.muted, { marginTop: 12, lineHeight: 24 }]}>İşe giriş ve işten çıkış işlemlerini zamanında hatırlayın. Gün içinde her uyarı bir kez gösterilir.</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24 }}>
              <Text style={{ fontSize: 18, fontWeight: '600', color: state.enabled ? C.ok : C.muted }}>{state.enabled ? 'Aktif' : 'Pasif'}</Text>
              <Switch accessibilityLabel="Hatırlatmaları aktif yap" value={state.enabled} disabled={busy} onValueChange={(enabled) => apply({ ...stateRef.current, enabled })} trackColor={{ true: C.ok }} />
            </View>
          </View>
          {!state.setupComplete ? <View style={[styles.card, styles.warnCard]}><Text style={styles.warnTitle}>İlk ayarları tamamlayın</Text><Text style={styles.warnText}>Çalışma saatlerinizi ve günlerinizi kaydedince hatırlatmalar başlayacak.</Text><Btn title="Ayarları aç" kind="outline" onPress={() => setSettingsOpen(true)} /></View> : null}
          <View style={styles.card}>
            <Text style={styles.h2}>{wp.name}</Text>
            <Text style={{ fontSize: 28, fontWeight: '600', color: C.text, marginVertical: 12 }}>{wp.start} — {wp.end}</Text>
            <Text style={styles.muted}>{MODE_LABELS[wp.mode]}</Text>
            <Text style={[styles.small, { marginTop: 10 }]}>{wp.workDays.map((d) => DAY_LABELS[d]).join(' · ')}</Text>
          </View>
          {state.enabled && !perms?.notifications ? <View style={[styles.card, styles.warnCard]}>
            <Text style={styles.warnTitle}>Bildirim izni gerekli</Text>
            <Text style={styles.warnText}>Telefon kilitliyken de hatırlatma almak için bildirimlere izin verin.</Text>
            <Btn title={perms?.notificationsAsked ? 'Telefon ayarlarını aç' : 'Bildirimlere izin ver'} kind="outline" onPress={perms?.notificationsAsked ? () => Linking.openSettings() : askNotifications} />
          </View> : null}
          {state.enabled && usesLocation(wp.mode) && (!locationConfigured || !perms?.locationAlways) ? <View style={[styles.card, styles.warnCard]}>
            <Text style={styles.warnTitle}>{locationConfigured ? 'Konum izni gerekli' : 'İş yeri konumunu ayarlayın'}</Text>
            <Text style={styles.warnText}>{locationConfigured ? 'Arka planda giriş ve çıkışı hatırlatmak için konum iznini “Her Zaman” yapın.' : 'Ayarlar bölümünde iş yeri konumunuzu kaydedin.'}</Text>
            <Btn title={locationConfigured ? 'Konum iznini ayarla' : 'Ayarları aç'} kind="outline" onPress={locationConfigured ? askLocation : () => setSettingsOpen(true)} />
          </View> : null}
          <Text style={styles.small}>{state.enabled ? `Saat uyarıları: ${usesTime(wp.mode) && perms?.notifications ? 'açık' : 'kapalı'} · Konum uyarıları: ${geofence ? 'açık' : 'kapalı'}` : 'Bildirimler ve konum izleme kapalı.'}</Text>
          {state.enabled && usesTime(wp.mode) && state.timeSchedule?.until ? <Text style={[styles.small, { marginTop: 10 }]}>Saat hatırlatmaları {new Date(state.timeSchedule.until).toLocaleDateString('tr-TR')} tarihine kadar hazır. Uygulamayı açınca sonraki 28 gün yenilenir.</Text> : null}
          <Text style={[styles.small, { marginTop: 20 }]}>EtkinIK yalnızca hatırlatır. Giriş ve çıkış işlemlerini kullandığınız sistemde kendiniz yaparsınız. Verileriniz telefonunuzda kalır.</Text>
          <Text style={[styles.small, { marginTop: 12 }]}>Sürüm 1.1.0</Text>
        </ScrollView>
      )}
      {error ? <Text accessibilityRole="alert" style={{ padding: 16, color: C.error }}>{error}</Text> : null}
      {busy ? <Text style={{ padding: 12, color: C.muted }}>Hatırlatmalar güncelleniyor…</Text> : null}
      {reminder && state.enabled ? <Pressable accessibilityRole="button" accessibilityLabel={`${alertTitle(reminder.kind)} Uyarıyı kapatmak için dokunun.`} onPress={dismiss}
        style={{ position: 'absolute', top: 70, bottom: 0, left: 0, right: 0, backgroundColor: reminder.kind === 'entry' ? '#154da7' : '#ad391c', padding: 32, justifyContent: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 52, fontWeight: '800', marginBottom: 24 }}>{reminder.kind === 'entry' ? 'GİRİŞ' : 'ÇIKIŞ'}</Text>
        <Text style={{ color: '#fff', fontSize: 30, fontWeight: '700', lineHeight: 38 }}>{alertTitle(reminder.kind)}</Text>
        <Text style={{ color: '#fff', fontSize: 19, lineHeight: 29, marginTop: 18 }}>{alertBody(reminder.kind)}</Text>
        <Text style={{ color: '#fff', fontSize: 15, marginTop: 50 }}>Uyarıyı kapatmak için ekrana dokunun.</Text>
      </Pressable> : null}
    </SafeAreaView>
  );
}
function Btn({ title, kind = 'primary', onPress, disabled, small }) {
  return <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}
    style={[styles.btn, small && styles.btnSmall, kind === 'primary' ? styles.btnPrimary : styles.btnOutline, disabled && { opacity: 0.5 }]}>
    <Text style={[styles.btnText, kind === 'primary' ? styles.btnPrimaryText : styles.btnOutlineText]}>{title}</Text>
  </Pressable>;
}
/* ===================== Ayarlar ===================== */

function formFrom(wp) {
  return {
    name: wp.name,
    lat: hasCoords(wp) ? wp.lat.toFixed(6) : '',
    lon: hasCoords(wp) ? wp.lon.toFixed(6) : '',
    entryRadius: String(radiusFor(wp, 'entry')),
    exitRadius: String(radiusFor(wp, 'exit')),
    start: wp.start || '',
    end: wp.end || '',
    mode: wp.mode,
    workDays: wp.workDays,
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

  const useCurrent = async () => {
    setLocBusy(true);
    setLocMsg(null);
    try {
      const pos = await readPosition();
      setForm((f) => ({ ...f, lat: pos.lat.toFixed(6), lon: pos.lon.toFixed(6) }));
      setErrors((e) => ({ ...e, coords: null }));
      const r = Math.min(...['entryRadius', 'exitRadius'].map((field) => radiusError(form[field]) ? 100 : Number(form[field])));
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
    const s = { ...state, setupComplete: true, workplaces: state.workplaces.map((w) => (w.id === res.wp.id ? res.wp : w)) };
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
            <Chip key={w.id} label={`${w.name} (giriş ${radiusFor(w, 'entry')} m / çıkış ${radiusFor(w, 'exit')} m)`} selected={w.id === wp.id}
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

        {['entry', 'exit'].map((kind) => {
          const field = `${kind}Radius`;
          const update = (value) => { set(field, value); setErrors((e) => ({ ...e, [field]: null })); };
          return (
            <View key={kind}>
              <Text style={styles.fieldLabel}>{kind === 'entry' ? 'Giriş kapsama alanı' : 'Çıkış kapsama alanı'}</Text>
              <Text style={styles.small}>{kind === 'entry' ? 'Bu alanın içine girince giriş uyarısı verilir.' : 'Bu alanın dışına çıkınca çıkış uyarısı verilir.'}</Text>
              <View style={styles.radiusRow}>
                <TextInput accessibilityLabel={kind === 'entry' ? 'Giriş kapsama alanı, metre' : 'Çıkış kapsama alanı, metre'}
                  style={[styles.input, styles.radiusInput, errors[field] && styles.invalid]}
                  value={form[field]} keyboardType="number-pad" maxLength={3}
                  onChangeText={(v) => update(v.replace(/[^0-9]/g, ''))}
                  onBlur={() => setErrors((e) => ({ ...e, [field]: radiusError(form[field]) }))} />
                <Text style={styles.unit}>m</Text>
              </View>
              <Slider accessibilityLabel={kind === 'entry' ? 'Giriş kapsama alanı' : 'Çıkış kapsama alanı'}
                style={{ height: 40, marginTop: 6 }} minimumValue={RADIUS_MIN} maximumValue={RADIUS_MAX} step={1}
                value={radiusError(form[field]) ? radiusFor(wp, kind) : Number(form[field])}
                minimumTrackTintColor={C.primary} maximumTrackTintColor={C.border}
                onValueChange={(v) => update(String(Math.round(v)))} />
              <View style={styles.scale}><Text style={styles.small}>10 m</Text><Text style={styles.small}>300 m</Text></View>
              <FieldError msg={errors[field]} />
            </View>
          );
        })}

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

        {usesLocation(form.mode) ? <Text style={styles.small}>Konum kullanılan yöntemlerde giriş: başlangıçtan 1 saat önce–14:00 arasında kapsama içine girince; çıkış: bitişten 1 saat önce–23:45 arasında kapsama dışına çıkınca. Saatin gelmesi tek başına uyarı oluşturmaz.</Text> : null}

        <Text style={styles.fieldLabel}>Çalışma günleri</Text>
        <View style={styles.chips}>
          {DAY_LABELS.map((label, d) => (
            <Chip key={d} label={label} selected={form.workDays.includes(d)}
              onPress={() => set('workDays', form.workDays.includes(d) ? form.workDays.filter((day) => day !== d) : [...form.workDays, d])} />
          ))}
        </View>
        <FieldError msg={errors.workDays} />

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
