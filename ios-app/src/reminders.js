import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import { activeWorkplace, saveState } from './storage';
import { alertBody, alertTitle, dateKey, hasCoords, isWorkDay, reminderId, timeFor, usesLocation, usesTime, workplaceRegions } from './logic';

export const GEOFENCE_TASK = 'etkinik-geofence';
export const SCHEDULE_DAYS = 28;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: AppState.currentState !== 'active',
    shouldShowList: AppState.currentState !== 'active',
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
export async function getPermissionSummary() {
  const [n, fg, bg] = await Promise.all([
    Notifications.getPermissionsAsync(), Location.getForegroundPermissionsAsync(), Location.getBackgroundPermissionsAsync(),
  ]);
  return { notifications: n.granted || n.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL,
    notificationsAsked: n.status !== 'undetermined', locationForeground: fg.status === 'granted',
    locationAlways: bg.status === 'granted', locationAsked: fg.status !== 'undetermined' };
}
export async function requestNotificationPermission() {
  return (await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })).granted;
}
export async function requestLocationPermissions() {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return false;
  return (await Location.requestBackgroundPermissionsAsync()).status === 'granted';
}
export async function cancelTodayTime(kind, now = new Date()) {
  await Notifications.cancelScheduledNotificationAsync(reminderId(dateKey(now), kind));
}
export async function dismissReminder(kind, day = dateKey()) {
  await Notifications.dismissNotificationAsync(reminderId(day, kind));
}
export async function stopAllReminders() {
  await Notifications.cancelAllScheduledNotificationsAsync();
  await Notifications.dismissAllNotificationsAsync();
  if (await isGeofencingActive()) await Location.stopGeofencingAsync(GEOFENCE_TASK);
}
export async function notifyOnce(kind, now = Date.now()) {
  await cancelTodayTime(kind, new Date(now));
  await Notifications.scheduleNotificationAsync({ identifier: reminderId(dateKey(new Date(now)), kind),
    content: { title: alertTitle(kind), body: alertBody(kind), sound: true, data: { kind, day: dateKey(new Date(now)) } }, trigger: null });
}

// One entry and one exit per selected workday. 28 days keeps the queue below iOS's limit.
// Refresh on launch/foreground.
export async function syncReminders(state, now = Date.now()) {
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!state.enabled || state.setupComplete === false) { await stopAllReminders(); state.timeSchedule = null; await saveState(state); return { count: 0, active: false }; }
  const wp = activeWorkplace(state);
  const permissions = await getPermissionSummary();
  const days = [];
  let count = 0;
  if (usesTime(wp.mode) && permissions.notifications) {
    for (let i = 0; i < SCHEDULE_DAYS; i++) {
      const day = new Date(now); day.setDate(day.getDate() + i); day.setHours(12, 0, 0, 0);
      if (!isWorkDay(wp, day)) continue;
      const key = dateKey(day); days.push(key);
      for (const kind of ['entry', 'exit']) {
        const due = timeFor(wp, kind, day);
        if (due == null || due <= now || state.days[key]?.[kind]) continue;
        await Notifications.scheduleNotificationAsync({ identifier: reminderId(key, kind),
          content: { title: alertTitle(kind), body: alertBody(kind), sound: true, data: { kind, day: key } },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(due) } });
        count++;
      }
    }
  }
  state.timeSchedule = { workplaceId: wp.id, createdAt: now, days, until: new Date(new Date(now).setDate(new Date(now).getDate() + SCHEDULE_DAYS - 1)).getTime() };
  await saveState(state);
  const active = await syncGeofencing(state, permissions);
  return { count, active };
}
export async function syncGeofencing(state, permissions) {
  const wp = activeWorkplace(state);
  const started = await isGeofencingActive();
  const bg = permissions?.locationAlways ?? (await Location.getBackgroundPermissionsAsync()).status === 'granted';
  if (!state.enabled || state.setupComplete === false || !usesLocation(wp.mode) || !hasCoords(wp) || !bg) {
    if (started) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return false;
  }
  const regions = workplaceRegions(wp);
  // Avoid re-registering on every foreground: iOS reports initial state on registration.
  const signature = JSON.stringify(regions);
  if (!started || state.geofenceSignature !== signature) {
    await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    state.geofenceSignature = signature;
    await saveState(state);
  }
  return true;
}
export const isGeofencingActive = () => Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
