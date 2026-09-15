const PAVE = 'https://api.jobtread.com/pave';
const grantKey = process.env.JT_GRANT_KEY;
const orgId = process.env.JT_ORG_ID;
const grantUserId = process.env.JT_USER_ID;

async function pave(fields, extraDollar = {}) {
  const body = { query: { $: { grantKey, ...extraDollar }, ...fields } };
  const res = await fetch(PAVE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _parseError: true, text: text.slice(0, 1500) }; }
  return { httpStatus: res.status, ok: res.ok, json, text: text.slice(0, 1500) };
}

console.log('===PAVE_AUTHORSHIP_PROBE_START===');
const out = { results: [] };

const bootstrap = await pave({
  organization: {
    $: { id: orgId },
    jobs: { $: { size: 5 }, nodes: { id: {}, number: {}, name: {} } },
    memberships: {
      $: { size: 50 },
      nodes: { id: {}, user: { id: {}, name: {} }, role: { name: {} } },
    },
  },
});
const jobs = bootstrap.json?.organization?.jobs?.nodes || [];
const members = bootstrap.json?.organization?.memberships?.nodes || [];
const job = jobs.find(j => j.number === '12059') || jobs[0];
const fieldEmp = members.find(m => m.role?.name === 'Field Employee');
const adminOther = members.find(m => m.user?.id !== grantUserId && m.role?.name === 'Admin');
const crewUserId = fieldEmp.user.id;
console.log('job', job.id, job.number, 'crew', fieldEmp.user.name, crewUserId);

const today = new Date().toISOString().slice(0, 10);
const note = 'FIELDAPP_AUTHORSHIP_PROBE3 ' + Date.now();

// Create baseline log
const created = await pave({
  createDailyLog: {
    $: { jobId: job.id, date: today, notes: note, files: [] },
    createdDailyLog: { id: {}, user: { id: {}, name: {} }, assignees: { nodes: { id: {}, name: {} } } },
  },
});
console.log('create', created.httpStatus, created.text.slice(0, 500));
const logId = created.json?.createDailyLog?.createdDailyLog?.id;

// Proper dailyLog selection like updateTask
const selFix = await pave({
  updateDailyLog: {
    $: { id: logId, notes: note + ' touched' },
    dailyLog: { $: { id: logId }, id: {}, notes: {}, user: { id: {}, name: {} } },
  },
});
console.log('update with dailyLog $ id', selFix.httpStatus, selFix.text.slice(0, 600));
out.results.push({ step: 'update:notes+dailyLogSel', http: selFix.httpStatus, body: selFix.json, text: selFix.text });

// Try assignee-related update fields
for (const [label, dollar] of [
  ['assigneeUserIds', { id: logId, assigneeUserIds: [crewUserId] }],
  ['assigneeIds', { id: logId, assigneeIds: [crewUserId] }],
  ['assignees', { id: logId, assignees: [crewUserId] }],
  ['addAssigneeUserIds', { id: logId, addAssigneeUserIds: [crewUserId] }],
  ['userIds', { id: logId, userIds: [crewUserId] }],
]) {
  const r = await pave({
    updateDailyLog: {
      $: dollar,
      dailyLog: { $: { id: logId }, id: {}, user: { id: {}, name: {} }, assignees: { nodes: { id: {}, name: {} } } },
    },
  });
  console.log('update', label, r.httpStatus, r.text.slice(0, 400));
  out.results.push({ step: 'update:' + label, http: r.httpStatus, text: r.text, json: r.json });
}

// createDailyLog with assignee variants
for (const [label, dollar] of [
  ['assignees_userIds', { jobId: job.id, date: today, notes: note + ' A1', files: [], assignees: [crewUserId] }],
  ['assigneeUserIds', { jobId: job.id, date: today, notes: note + ' A2', files: [], assigneeUserIds: [crewUserId] }],
  ['assigneeIds', { jobId: job.id, date: today, notes: note + ' A3', files: [], assigneeIds: [crewUserId] }],
  ['userId_again', { jobId: job.id, date: today, notes: note + ' A4', files: [], userId: crewUserId }],
]) {
  const r = await pave({
    createDailyLog: {
      $: dollar,
      createdDailyLog: {
        id: {},
        user: { id: {}, name: {} },
        assignees: { nodes: { id: {}, name: {} } },
      },
    },
  });
  console.log('create', label, r.httpStatus, r.text.slice(0, 500));
  const cl = r.json?.createDailyLog?.createdDailyLog;
  out.results.push({
    step: 'create:' + label,
    http: r.httpStatus,
    text: r.text,
    user: cl?.user || null,
    assignees: cl?.assignees || null,
    successUser: cl?.user?.id === crewUserId,
  });
}

// viaUserId Field Employee + permission-sensitive mutation: try updateTask or list something
// Force permission error: viaUserId with customer?
const customer = members.find(m => m.role?.name === 'Customer');
if (customer) {
  const viaCust = await pave(
    {
      createDailyLog: {
        $: { jobId: job.id, date: today, notes: note + ' VIA_CUST', files: [] },
        createdDailyLog: { id: {}, user: { id: {}, name: {} } },
      },
    },
    { viaUserId: customer.user.id }
  );
  console.log('viaCustomer', customer.user.name, viaCust.httpStatus, viaCust.text.slice(0, 500));
  out.results.push({ step: 'create:viaUserId:Customer', http: viaCust.httpStatus, text: viaCust.text, json: viaCust.json });
}

// via Field Emp again but capture if errors array appears on 200
const viaFE = await pave(
  {
    createDailyLog: {
      $: { jobId: job.id, date: today, notes: note + ' VIA_FE2', files: [] },
      createdDailyLog: { id: {}, user: { id: {}, name: {} } },
    },
  },
  { viaUserId: crewUserId }
);
console.log('viaFE2', viaFE.httpStatus, viaFE.text.slice(0, 500));
out.results.push({
  step: 'create:viaUserId:FieldEmployee',
  http: viaFE.httpStatus,
  text: viaFE.text,
  user: viaFE.json?.createDailyLog?.createdDailyLog?.user || null,
});

// Probe: does createDailyLog accept anything about user in schema by typo discovery
const typo = await pave({
  createDailyLog: {
    $: { jobId: job.id, date: today, notes: note + ' TYPO', files: [], notARealField: true },
    createdDailyLog: { id: {} },
  },
});
console.log('typoField', typo.httpStatus, typo.text.slice(0, 400));
out.results.push({ step: 'create:typoField', http: typo.httpStatus, text: typo.text });

console.log('=== VERDICT TABLE ===');
console.log(JSON.stringify(out, null, 2));
console.log('===PAVE_AUTHORSHIP_PROBE_END===');
process.exit(0);