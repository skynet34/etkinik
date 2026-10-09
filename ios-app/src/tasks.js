import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { serialize } from './operations';
import { activeWorkplace, ensureDay, loadState, saveState } from './storage';
import { isWorkDay, locationReminder, markReminder } from './logic';
import { GEOFENCE_TASK, notifyOnce } from './reminders';

TaskManager.defineTask(GEOFENCE_TASK, ({ data, error }) => serialize(async () => {
  if (error || !data) return;
  const state = await loadState();
  const wp = activeWorkplace(state);
  if (!state.enabled || data.region?.identifier !== wp.id) return;
  const now = Date.now();
  const day = ensureDay(state, new Date(now));
  const entering = data.eventType === Location.GeofencingEventType.Enter;
  if (entering && isWorkDay(wp, new Date(now))) day.seenInside = true;
  const kind = locationReminder(state, wp, entering ? 'enter' : 'exit', now);
  if (kind) {
    await notifyOnce(kind, now);
    markReminder(state, kind, now);
  }
  day.inside = entering;
  state.lastRegionEvent = { inside: entering, time: now, workplaceId: wp.id };
  await saveState(state);
}));
