const normalize = name => String(name || '').toLowerCase().trim()
  .replace(/^dr(?:a)?(?:\.\s*|\s+)/, '').replace(/\s*,?\s*d\.?m\.?d\.?\s*$/, '')
  .replace(/\s+/g, ' ').trim();

function buildDentistDirectory(users, appointments, today) {
  const dentists = users.map(user => ({ ...user, display_name: `Dr. ${user.first_name} ${user.last_name}`, patient_count: 0, status: user.status || 'Available' }));
  const patients = new Map(dentists.map(dentist => [dentist, new Set()]));
  const unregistered = new Map();
  for (const appointment of appointments) {
    const name = normalize(appointment.dentist_name);
    if (!name) continue;
    let matches = dentists.filter(dentist => normalize(`${dentist.first_name} ${dentist.last_name}`) === name);
    // Legacy records sometimes use a different given name. A complete surname
    // can resolve them only when it identifies exactly one registered dentist.
    if (!matches.length) matches = dentists.filter(dentist => {
      const surname = normalize(dentist.last_name);
      return surname && (name === surname || name.endsWith(` ${surname}`));
    });
    if (matches.length > 1) {
      const branch = value => String(value || 'Main Branch').trim().toLowerCase().replace(/^main branch$/, 'gil puyat, pasay');
      matches = matches.filter(dentist => branch(dentist.branch) === branch(appointment.branch));
    }
    let dentist = matches.length === 1 ? matches[0] : null;
    if (!dentist) {
      if (!unregistered.has(name)) {
        const record = { id: null, directory_id: `APPT-${unregistered.size + 1}`, display_name: String(appointment.dentist_name).trim(), specialty: 'Not recorded', branch: appointment.branch || 'Main Branch', status: 'Available', appointment_only: true, patient_count: 0 };
        unregistered.set(name, record);
        patients.set(record, new Set());
      }
      dentist = unregistered.get(name);
    }
    if (appointment.status !== 'Cancelled' && appointment.user_id != null) patients.get(dentist).add(String(appointment.user_id));
    if (appointment.date === today && ['Confirmed', 'Approved'].includes(appointment.status)) dentist.status = 'Busy';
  }
  const result = [...dentists, ...unregistered.values()];
  for (const dentist of result) dentist.patient_count = patients.get(dentist).size;
  return result.sort((a, b) => a.display_name.localeCompare(b.display_name));
}
module.exports = { buildDentistDirectory };
