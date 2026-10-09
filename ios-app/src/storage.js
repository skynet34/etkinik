import AsyncStorage from '@react-native-async-storage/async-storage';
import { dateKey, newWorkplace, WORK_DAYS } from './logic';

const KEY = 'etkinik.v2';
const OLD_KEY = 'etkinik.v1';
const defaults = () => ({ version: 2, enabled: true, setupComplete: false, activeId: null, workplaces: [], days: {}, lastPos: null, timeSchedule: null });

export async function loadState() {
  let state = defaults();
  const raw = await AsyncStorage.getItem(KEY);
  if (raw) {
    try { state = { ...state, ...JSON.parse(raw) }; } catch { /* Recover malformed local settings. */ }
  } else {
    const old = await AsyncStorage.getItem(OLD_KEY);
    if (old) {
      try {
        const previous = JSON.parse(old);
        state.workplaces = previous.workplaces || [];
        state.activeId = previous.activeId;
        state.setupComplete = previous.workplaces?.length > 0;
      } catch { /* Use clean defaults. Original v1 data remains untouched. */ }
    }
  }
  if (!Array.isArray(state.workplaces)) state.workplaces = [];
  if (!state.days || typeof state.days !== 'object') state.days = {};
  state.workplaces = state.workplaces.map(({ repeat: _repeat, ...wp }) => ({ ...wp, workDays: wp.workDays || [...WORK_DAYS] }));
  if (!state.workplaces.length) {
    const wp = newWorkplace('İş yerim');
    state.workplaces = [wp];
    state.activeId = wp.id;
  }
  if (!getWorkplace(state, state.activeId)) state.activeId = state.workplaces[0].id;
  const cut = new Date(); cut.setDate(cut.getDate() - 35);
  for (const key of Object.keys(state.days)) if (key < dateKey(cut)) delete state.days[key];
  return state;
}
export const saveState = (state) => AsyncStorage.setItem(KEY, JSON.stringify(state));
export const getWorkplace = (state, id) => state.workplaces.find((wp) => wp.id === id) || null;
export const activeWorkplace = (state) => getWorkplace(state, state.activeId) || state.workplaces[0];
export function ensureDay(state, now = new Date()) {
  const key = dateKey(now);
  if (!state.days[key]) state.days[key] = {};
  return state.days[key];
}
