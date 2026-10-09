import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

async function runtime() {
 const calls = { scheduled: [], cancelled: 0, stopped: 0, dismissed: 0 };
 const saved = new Map(); let geofencing = true;
 const context = vm.createContext({ console, Date, JSON, Math, Object, Array, Number, String, Boolean, Promise, Set });
 const modules = new Map();
 const synthetic = (exports) => new vm.SyntheticModule(Object.keys(exports), function() { for (const [key,value] of Object.entries(exports)) this.setExport(key,value); }, { context });
 modules.set('react-native',synthetic({ AppState: { currentState:'background' } }));
 modules.set('@react-native-async-storage/async-storage',synthetic({ default: { getItem:async key=>saved.get(key), setItem:async (key,value)=>saved.set(key,value) } }));
 modules.set('expo-notifications',synthetic({
  setNotificationHandler: () => {}, IosAuthorizationStatus: { PROVISIONAL:3 }, SchedulableTriggerInputTypes:{ DATE:'date' },
  getPermissionsAsync: async()=>({ granted:true,status:'granted' }), requestPermissionsAsync:async()=>({ granted:true }),
  cancelScheduledNotificationAsync:async id=>{ calls.lastCancelled=id; },
  dismissNotificationAsync:async()=>{}, cancelAllScheduledNotificationsAsync:async()=>{ calls.cancelled++; calls.scheduled=[]; },
  dismissAllNotificationsAsync:async()=>{ calls.dismissed++; },
  scheduleNotificationAsync:async n=>{ calls.scheduled.push(n); return n.identifier; },
 }));
 modules.set('expo-location',synthetic({
  getForegroundPermissionsAsync:async()=>({ status:'granted' }), getBackgroundPermissionsAsync:async()=>({status:'granted'}),
  requestForegroundPermissionsAsync:async()=>({status:'granted'}),requestBackgroundPermissionsAsync:async()=>({status:'granted'}),
  hasStartedGeofencingAsync:async()=>geofencing,
  stopGeofencingAsync:async()=>{ calls.stopped++;geofencing=false; },
  startGeofencingAsync:async()=>{geofencing=true;},
 }));
 const load = async spec => {
  if (modules.has(spec)) return modules.get(spec);
  const name = spec.replace('./','');
  const source = await readFile(new URL(`../src/${name}.js`,import.meta.url),'utf8');
  const mod = new vm.SourceTextModule(source,{context});modules.set(spec,mod);
  await mod.link(load);return mod;
 };
 const reminders = await load('./reminders'); await reminders.evaluate();
 const logic = modules.get('./logic').namespace;
 const storage = modules.get('./storage').namespace;
 return { calls, saved, reminders:reminders.namespace, logic,storage };
}

test('queue schedules no more than 56 single alerts, with no repeat timer',async()=>{
 const {reminders,logic,calls} = await runtime();
 const wp={...logic.newWorkplace('Office'),id:'office',workDays:[0,1,2,3,4,5,6],mode:'time'};
 const state={enabled:true,setupComplete:true,activeId:'office',workplaces:[wp],days:{}};
 await reminders.syncReminders(state,new Date(2026,9,9,7).getTime());
 assert.equal(calls.scheduled.length,56);
 assert.equal(new Set(calls.scheduled.map(n=>n.identifier)).size,56);
 assert.ok(calls.scheduled.every(n=>n.trigger.type==='date' && !n.trigger.repeats));
});
test('passive cancels pending and visible notifications and stops geofencing',async()=>{
 const {reminders,logic,calls} = await runtime();
 const wp=logic.newWorkplace('Office');
 const state={enabled:false,activeId:wp.id,workplaces:[wp],days:{}};
 const result=await reminders.syncReminders(state);
 assert.equal(calls.scheduled.length,0);assert.equal(calls.stopped,1);assert.equal(calls.dismissed,1);assert.equal(result.active,false);
});
test('reminder already handled today is excluded from schedule',async()=>{
 const {reminders,logic,calls} = await runtime();const now=new Date(2026,9,9,7);
 const wp={...logic.newWorkplace('Office'),mode:'time'};
 const state={enabled:true,activeId:wp.id,workplaces:[wp],days:{[logic.dateKey(now)]:{entry:{delivered:now.getTime(),dismissed:true}}}};
 await reminders.syncReminders(state,now.getTime());
 assert.ok(!calls.scheduled.some(n=>n.identifier===logic.reminderId(logic.dateKey(now),'entry')));
 assert.ok(calls.scheduled.some(n=>n.identifier===logic.reminderId(logic.dateKey(now),'exit')));
});
test('v1 settings migrate without importing clock-in records or deleting originals',async()=>{
 const {storage,saved} = await runtime();
 const original=JSON.stringify({activeId:'office',workplaces:[{id:'office',name:'Old',repeat:10}],days:{'2026-10-09':{entry:123}}});
 saved.set('etkinik.v1',original);
 const state=await storage.loadState();
 assert.equal(state.version,2);assert.equal(state.setupComplete,true);assert.equal(state.workplaces[0].repeat,undefined);
 assert.deepEqual(JSON.parse(JSON.stringify(state.days)),{});assert.equal(saved.get('etkinik.v1'),original);
});
