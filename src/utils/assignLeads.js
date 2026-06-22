/**
 * Distribute lead IDs equally across selected employee IDs.
 * Remainder leads are distributed round-robin to first N employees.
 *
 * @param {string[]} leadIds      - Array of lead UUIDs
 * @param {string[]} employeeIds  - Array of employee UUIDs to assign to
 * @returns {{ employeeId: string, leads: string[] }[]}
 */
function distributeLeads(leadIds, employeeIds) {
  if (!employeeIds.length) return [];

  const baseCount  = Math.floor(leadIds.length / employeeIds.length);
  const remainder  = leadIds.length % employeeIds.length;

  const assignments = employeeIds.map((empId, idx) => ({
    employeeId: empId,
    leads: [],
  }));

  let cursor = 0;
  employeeIds.forEach((_, idx) => {
    const count = baseCount + (idx < remainder ? 1 : 0);
    assignments[idx].leads = leadIds.slice(cursor, cursor + count);
    cursor += count;
  });

  return assignments;
}

module.exports = { distributeLeads };
