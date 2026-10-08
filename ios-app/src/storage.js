// Cihaz üzerinde saklama (sunucu yok). Arka plan görevleri de aynı veriyi okur.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { dateKey, newWorkplace } from './logic';

const KEY = 'etkinik.v1';
const KEEP_DAYS = 90;

function defaults() {
  return { version: 1, activeId: null, workplaces: [], days: {}, lastPos: null };
}

export async function loadState() {
  let s;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    s = raw ? { ...defaults(), ...JSON.parse(raw) } : defaults();
  } catch (e) {
    s = defaults();
  }
  if (!Array.isArray(s.workplaces)) s.workplaces = [];
  if (!s.days || typeof s.days !== 'object') s.days = {};
  if (!s.workplaces.length) {
    const wp = newWorkplace('Merkez Ofis');
    s.workplaces.push(wp);
    s.activeId = wp.id;
  }
  if (!getWorkplace(s, s.activeId)) s.activeId = s.workplaces[0].id;
  prune(s);
  return s;
}

export async function saveState(s) {
  await AsyncStorage.setItem(KEY, JSON.stringify(s));
}

function prune(s) {
  const cut = new Date();
  cut.setDate(cut.getDate() - KEEP_DAYS);
  const cutKey = dateKey(cut);
  Object.keys(s.days).forEach((k) => { if (k < cutKey) delete s.days[k]; });
}

export const getWorkplace = (s, id) => s.workplaces.find((w) => w.id === id) || null;
export const activeWorkplace = (s) => getWorkplace(s, s.activeId) || s.workplaces[0];
export const todayRecord = (s) => s.days[dateKey()] || null;
export function ensureToday(s) {
  const k = dateKey();
  if (!s.days[k]) s.days[k] = {};
  return s.days[k];
}
/** Bugünkü hatırlatmalar: giriş yapılan iş yeri, yoksa aktif iş yeri */
export const currentWorkplace = (s) => {
  const rec = todayRecord(s);
  return (rec && rec.workplaceId && getWorkplace(s, rec.workplaceId)) || activeWorkplace(s);
};
