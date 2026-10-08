// Arka plan görevi: iOS, iş yeri bölgesine girildiğinde/çıkıldığında uygulama
// kapalı olsa bile bu kodu kısa süreliğine çalıştırır.
// Bu dosya index.js'de, uygulama bileşeninden ÖNCE yüklenmelidir.
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { minutesOfDay, parseHHMM, usesLocation } from './logic';
import { loadState, saveState, todayRecord, ensureToday, getWorkplace, activeWorkplace } from './storage';
import { GEOFENCE_TASK, notifyLocationExit, cancelLocationRepeats, notifyEntry } from './reminders';

const ENTRY_EARLY_MIN = 120; // mesai başlangıcından en fazla 2 saat önce giriş hatırlatması

function inEntryWindow(wp, now = new Date()) {
  const s = parseHHMM(wp.start);
  const e = parseHHMM(wp.end);
  const n = minutesOfDay(now);
  if (s != null && n < s - ENTRY_EARLY_MIN) return false;
  if (e != null && n >= e) return false;
  return true;
}

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data) return;
  const { eventType, region } = data;
  try {
    const state = await loadState();
    const wp = getWorkplace(state, region && region.identifier);
    if (!wp || !usesLocation(wp.mode)) return;
    const now = Date.now();
    const rec = todayRecord(state);
    state.lastRegionEvent = { type: eventType === Location.GeofencingEventType.Exit ? 'exit' : 'enter', wpId: wp.id, time: now };

    if (eventType === Location.GeofencingEventType.Exit) {
      // Giriş bu iş yerinde yapıldı ve çıkış yapılmadıysa: hatırlat. Kayıt OLUŞTURMA.
      if (rec && rec.entry && !rec.exit && rec.workplaceId === wp.id) {
        rec.leftAt = now;
        await saveState(state);
        await notifyLocationExit(wp);
        return;
      }
    } else if (eventType === Location.GeofencingEventType.Enter) {
      if (rec && rec.entry && !rec.exit && rec.workplaceId === wp.id) {
        rec.backAt = now;
        rec.seenInside = true;
        await saveState(state);
        await cancelLocationRepeats();
        return;
      }
      const active = activeWorkplace(state);
      if ((!rec || (!rec.entry && !rec.exit)) && active.id === wp.id && inEntryWindow(wp)) {
        const r = ensureToday(state);
        if (!r.entryNotified) {
          r.entryNotified = true;
          await saveState(state);
          await notifyEntry(wp);
          return;
        }
      }
    }
    await saveState(state);
  } catch (e) {
    // Arka planda hata kullanıcıya gösterilemez; bir sonraki olayda tekrar denenir.
  }
});
