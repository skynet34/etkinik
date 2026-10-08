// iOS'a özgü katman: yerel bildirimler + sistem geofencing.
// Uygulama kapalıyken de çalışan kısım burası.
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import { hasCoords, todayAt, usesLocation, usesTime } from './logic';

export const GEOFENCE_TASK = 'etkinik-geofence';
const MAX_TIME_REMINDERS = 30;
const TIME_REMINDER_WINDOW_MS = 3 * 60 * 60 * 1000; // mesai bitişinden sonra 3 saat boyunca tekrar et
const LOCATION_REPEATS = 6;

const EXIT_TITLE = 'Çıkış yapmayı unutma!';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/* ---------- İzinler ---------- */

export async function getPermissionSummary() {
  const [n, fg, bg] = await Promise.all([
    Notifications.getPermissionsAsync(),
    Location.getForegroundPermissionsAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return {
    notifications: n.granted || n.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL,
    notificationsAsked: n.status !== 'undetermined',
    locationForeground: fg.status === 'granted',
    locationAlways: bg.status === 'granted',
    locationAsked: fg.status !== 'undetermined',
  };
}

export async function requestNotificationPermission() {
  const res = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowSound: true, allowBadge: false },
  });
  return res.granted;
}

/** Önce "Uygulamayı kullanırken", ardından "Her zaman" izni istenir (iOS bu sırayı şart koşar). */
export async function requestLocationPermissions() {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return { foreground: false, always: false };
  const bg = await Location.requestBackgroundPermissionsAsync();
  return { foreground: true, always: bg.status === 'granted' };
}

/* ---------- Bildirim yardımcıları ---------- */

async function cancelByPrefix(prefix) {
  const list = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    list.filter((n) => n.identifier.startsWith(prefix)).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
  );
}

async function dismissByPrefix(prefix) {
  const list = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    list
      .filter((n) => n.request.identifier.startsWith(prefix))
      .map((n) => Notifications.dismissNotificationAsync(n.request.identifier))
  );
}

/**
 * "Giriş yaptım" sonrası: mesai bitişinde ve ardından tekrar süresi aralıklarla
 * çıkış hatırlatmalarını telefona zamanla. Uygulama kapalı olsa da iOS bunları gösterir.
 */
export async function scheduleTimeExitReminders(wp, now = Date.now()) {
  await cancelByPrefix('exit-time-');
  if (!usesTime(wp.mode)) return 0;
  const endTs = todayAt(wp.end);
  if (endTs == null) return 0;
  const step = (wp.repeat || 0) * 60000;
  const times = [];
  if (step === 0) {
    if (endTs > now) times.push(endTs);
  } else {
    for (let t = endTs; t <= endTs + TIME_REMINDER_WINDOW_MS && times.length < MAX_TIME_REMINDERS; t += step) {
      if (t > now + 5000) times.push(t);
    }
  }
  await Promise.all(
    times.map((t, i) =>
      Notifications.scheduleNotificationAsync({
        identifier: `exit-time-${i}`,
        content: { title: EXIT_TITLE, body: `Mesai bitti (${wp.end}). İK uygulamanızda çıkış yapmayı unutma.`, sound: true },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t },
      })
    )
  );
  return times.length;
}

/** Geofencing "alandan çıktı" dediğinde: hemen bildir, sonra tekrar süresiyle yinele. */
export async function notifyLocationExit(wp) {
  await cancelByPrefix('exit-loc-');
  const content = {
    title: EXIT_TITLE,
    body: `${wp.name} alanından ayrıldınız. İK uygulamanızda çıkış yapmayı unutma.`,
    sound: true,
  };
  await Notifications.scheduleNotificationAsync({ identifier: 'exit-loc-0', content, trigger: null });
  const step = (wp.repeat || 0) * 60;
  if (step > 0) {
    for (let i = 1; i <= LOCATION_REPEATS; i++) {
      await Notifications.scheduleNotificationAsync({
        identifier: `exit-loc-${i}`,
        content,
        trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: step * i, repeats: false },
      });
    }
  }
}

/** Alana geri dönüldüyse konum kaynaklı tekrarları durdur (saat hatırlatmaları kalır). */
export async function cancelLocationRepeats() {
  await cancelByPrefix('exit-loc-');
}

export async function notifyEntry(wp) {
  await Notifications.scheduleNotificationAsync({
    identifier: 'entry-loc',
    content: {
      title: 'Giriş yapmayı unutma!',
      body: `${wp.name} alanındasınız. İK uygulamanızda giriş yaptıysanız Etkinik'te "Giriş yaptım"a basın.`,
      sound: true,
    },
    trigger: null,
  });
}

/** "Çıkış yaptım": bekleyen ve ekrandaki tüm çıkış hatırlatmalarını kaldır. */
export async function clearExitReminders() {
  await cancelByPrefix('exit-');
  await dismissByPrefix('exit-');
  await dismissByPrefix('entry-');
}

export async function clearEntryReminders() {
  await dismissByPrefix('entry-');
}

/* ---------- Geofencing ---------- */

/**
 * Konum kullanan ve koordinatı olan tüm iş yerlerini iOS bölge izlemeye verir.
 * "Her zaman" konum izni yoksa izleme yapılamaz.
 */
export async function syncGeofencing(state) {
  const regions = state.workplaces
    .filter((w) => usesLocation(w.mode) && hasCoords(w))
    .slice(0, 20) // iOS sınırı: uygulama başına 20 bölge
    .map((w) => ({
      identifier: w.id,
      latitude: w.lat,
      longitude: w.lon,
      radius: w.radius,
      notifyOnEnter: true,
      notifyOnExit: true,
    }));

  const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (!regions.length) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return { active: false, reason: 'noregion' };
  }
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return { active: false, reason: 'permission' };
  }
  await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
  return { active: true, count: regions.length };
}

export async function isGeofencingActive() {
  return Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
}
