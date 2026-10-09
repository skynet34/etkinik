import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
const source = await readFile(new URL('../src/logic.js', import.meta.url), 'utf8');
const L = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const at = (hour, minute = 0, day = 9) => new Date(2026, 9, day, hour, minute).getTime();
const wp = { ...L.newWorkplace('Test'), id: 'office', lat: 41, lon: 29 };
const state = () => ({ enabled: true, days: {}, activeId: 'office', workplaces: [wp] });
test('entry and exit are independent without attendance acknowledgement', () => {
 const s = state(); assert.equal(L.foregroundReminder(s, wp, at(9)), 'entry');
 L.markReminder(s, 'entry', at(9), true);
 assert.equal(L.foregroundReminder(s, wp, at(10)), null);
 assert.equal(L.foregroundReminder(s, wp, at(18)), 'exit');
 L.markReminder(s, 'exit', at(18), true);
 assert.equal(L.foregroundReminder(s, wp, at(19)), null);
 assert.equal(L.foregroundReminder(s, wp, at(9,0,12)), 'entry');
});
test('passive disables all foreground and geofence reminders', () => {
 const s = { ...state(), enabled: false };
 assert.equal(L.foregroundReminder(s, wp, at(18)), null);
 assert.equal(L.locationReminder(s, wp, 'enter', at(9)), null);
});
test('weekends do not trigger', () => {
 assert.equal(L.foregroundReminder(state(), wp, at(9,0,10)), null);
 assert.equal(L.locationReminder(state(), wp, 'enter', at(9,0,10)), null);
});
test('departure does not require a clock-in button but requires a visit', () => {
 const s = state(); assert.equal(L.locationReminder(s, wp, 'exit', at(17)), null);
 s.days[L.dateKey(new Date(at(9)))] = { seenInside: true };
 assert.equal(L.locationReminder(s, wp, 'exit', at(17)), 'exit');
 L.markReminder(s, 'exit', at(17));
 assert.equal(L.locationReminder(s, wp, 'exit', at(17,1)), null);
});
test('arrival is limited to the work window', () => {
 assert.equal(L.locationReminder(state(), wp, 'enter', at(6)), null);
 assert.equal(L.locationReminder(state(), wp, 'enter', at(7)), 'entry');
 assert.equal(L.locationReminder(state(), wp, 'enter', at(18)), null);
});
test('time notification followed by region exit is not repeated', () => {
 const s = state(); const key = L.dateKey(new Date(at(9)));
 s.days[key] = { seenInside: true };
 s.timeSchedule = { workplaceId: wp.id, createdAt: at(8), days: [key] };
 assert.equal(L.locationReminder(s, wp, 'exit', at(18,1)), null);
 assert.equal(L.locationReminder(s, wp, 'exit', at(17)), 'exit');
});
test('location-only does not raise a time alarm', () => {
 assert.equal(L.foregroundReminder(state(), { ...wp, mode: L.MODES.LOCATION }, at(18)), null);
});
test('dismissal closes the alert without recording attendance', () => {
 const s = state(); L.markReminder(s, 'entry', at(9));
 assert.equal(L.foregroundReminder(s, wp, at(10)), 'entry');
 L.markReminder(s, 'entry', at(10), true);
 assert.equal(L.foregroundReminder(s, wp, at(11)), null);
 const day = s.days[L.dateKey(new Date(at(9)))];
 assert.equal(day.entry.dismissed, true); assert.equal(day.exit, undefined);
});
test('validation rejects missing hours and overnight shift for every mode', () => {
 const form = { ...wp, radius: '100', lat: '41', lon: '29', start: '', end: '', mode: L.MODES.LOCATION };
 assert.equal(L.validateWorkplace(wp,form).ok, false);
 assert.equal(L.validateWorkplace(wp,{ ...form, start:'22:00',end:'06:00' }).ok,false);
 assert.equal(L.validateWorkplace(wp,{ ...form, start:'08:30',end:'18:00',workDays:[] }).ok,false);
 assert.equal(L.validateWorkplace(wp,{ ...form, start:'08:30',end:'18:00' }).ok,true);
});
