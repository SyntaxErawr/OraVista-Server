const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDentistDirectory } = require('../dentist-directory');
const today = '2026-10-08';
const users = [
  { id: 1, first_name: 'Theresa', last_name: 'Madrid', branch: 'Main Branch', status: 'Available' },
  { id: 2, first_name: 'Alex', last_name: 'Lee', branch: 'Main Branch', status: 'Off Duty' },
  { id: 3, first_name: 'Jane', last_name: 'Lee', branch: 'Main Branch', status: 'Available' },
  { id: 4, first_name: 'Drake', last_name: 'Chan', branch: 'Main Branch', status: 'Available' },
];
const visit = (dentist_name, user_id, status = 'Confirmed', date = today) => ({ dentist_name, user_id, status, date, branch: 'Main Branch' });

test('includes every registered dentist and appointment-only names without creating users', () => {
  const result = buildDentistDirectory(users, [visit('Dra.Paulette Maliit', 7), visit('Paulette Maliit DMD', 8)], today);
  assert.equal(result.length, 5);
  assert.equal(result.filter(item => item.id != null).length, users.length);
  const extra = result.find(item => item.appointment_only);
  assert.equal(extra.patient_count, 2);
  assert.equal(extra.id, null);
  assert.equal(extra.status, 'Busy');
  assert.ok(extra.directory_id);
});

test('normalizes titles and credentials; counts patients once and excludes cancellations', () => {
  const result = buildDentistDirectory(users, [visit('Dra. Theresa Madrid', 7), visit('Theresa Madrid DMD', 7), visit('Therese Madrid DMD', 8, 'Approved'), visit('Dr Theresa Madrid', 9, 'Cancelled')], today);
  assert.equal(result.length, 4);
  assert.equal(result.find(item => item.id === 1).patient_count, 2);
  assert.equal(result.find(item => item.id === 1).status, 'Busy');
});

test('same surname does not mix patients and ambiguous legacy names stay separate', () => {
  const result = buildDentistDirectory(users, [visit('Dr. Alex Lee', 1), visit('Jane Lee DMD', 2), visit('Unknown Lee', 3)], today);
  assert.equal(result.find(item => item.id === 2).patient_count, 1);
  assert.equal(result.find(item => item.id === 3).patient_count, 1);
  assert.equal(result.find(item => item.appointment_only).patient_count, 1);
});

test('historical, cancelled and completed visits do not make a dentist busy today', () => {
  const result = buildDentistDirectory(users, [visit('Alex Lee', 1, 'Confirmed', '2026-10-07'), visit('Drake Chan', 2, 'Completed'), visit('Theresa Madrid', 3, 'Cancelled')], today);
  assert.equal(result.find(item => item.id === 2).status, 'Off Duty');
  assert.equal(result.find(item => item.id === 4).status, 'Available');
  assert.equal(result.find(item => item.id === 4).patient_count, 1);
  assert.equal(result.find(item => item.id === 1).patient_count, 0);
});

test('empty appointments retain all dentists and skip blank names', () => {
  assert.equal(buildDentistDirectory(users, [], today).length, 4);
  assert.equal(buildDentistDirectory([], [visit('', 1), visit(null, 2)], today).length, 0);
});
