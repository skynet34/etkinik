import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { serialize } from './operations';
import { activeWorkplace, loadState, saveState } from './storage';
import { regionReminder, markReminder } from './logic';
import { GEOFENCE_TASK, notifyOnce } from './reminders';

TaskManager.defineTask(GEOFENCE_TASK, ({ data, error }) => serialize(async () => {
  if (error || !data) return;
  const state = await loadState();
  const wp = activeWorkplace(state);
  if (!state.enabled) return;
  const now = Date.now();
  const entering = data.eventType === Location.GeofencingEventType.Enter;
  const kind = regionReminder(state, wp, data.region?.identifier, entering, now);
  if (kind) {
    await notifyOnce(kind, now);
    markReminder(state, kind, now);
  }
  await saveState(state);
}));
