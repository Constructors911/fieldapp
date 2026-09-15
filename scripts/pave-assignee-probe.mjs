const PAVE = 'https://api.jobtread.com/pave';
const grantKey = process.env.JT_GRANT_KEY;
const orgId = process.env.JT_ORG_ID;
const grantUserId = process.env.JT_USER_ID;
const JORGE_USER_ID = '22PW9EGkEvjJ';
const JOB_12059 = '22PRE9tUST7n';

async function pave(fields) {
  const res = await fetch(PAVE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { $: { grantKey }, ...fields } }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _parseError: true, text: text.slice(0, 2000) }; }
  return { httpStatus: res.status, ok: res.ok, json, text: text.slice(0, 2000) };
}
function S(r) {
  return r.json?._parseError ? ('HTTP ' + r.httpStatus + ' plain: ' + r.text) : ('HTTP ' + r.httpStatus + ' json: ' + JSON.stringify(r.json).slice(0, 900));
}

console.log('===PAVE_ASSIGNEE_EMAIL_PROBE_START===');
const today = new Date().toISOString().slice(0, 10);
const note = 'FIELDAPP_ASSIGNEE_PROBE ' + Date.now();
const out = { results: [] };

// Try to get Jorge email via account/person fields
for (const sel of [
  { label: 'user.emailAddress', q: { user: { $: { id: JORGE_USER_ID }, id: {}, name: {}, emailAddress: {} } } },
  { label: 'user.email', q: { user: { $: { id: JORGE_USER_ID }, id: {}, name: {}, email: {} } } },
  { label: 'user.emails', q: { user: { $: { id: JORGE_USER_ID }, id: {}, name: {}, emails: { nodes: { id: {}, address: {} } } } } },
  { label: 'account.email', q: { user: { $: { id: JORGE_USER_ID }, id: {}, name: {}, account: { id: {}, emailAddress: {}, email: {} } } } },
]) {
  const r = await pave(sel.q);
  console.log('emailSel', sel.label, S(r));
  out.results.push({ step: 'emailSel:' + sel.label, httpStatus: r.httpStatus, text: r.text, json: r.json });
}

// Discover required keys on assignees object by partial objects
const partials = [
  { label: 'emailOnly_fake', assignees: [{ emailAddress: 'jorge.perez@example.com' }] },
  { label: 'emailPlusId', assignees: [{ emailAddress: 'jorge.perez@example.com', id: JORGE_USER_ID }] },
  { label: 'emailPlusName', assignees: [{ emailAddress: 'jorge.perez@example.com', name: 'Jorge Perez' }] },
  { label: 'emailPlusUserId', assignees: [{ emailAddress: 'jorge.perez@example.com', userId: JORGE_USER_ID }] },
  { label: 'emptyObject', assignees: [{}] },
  { label: 'nameOnly', assignees: [{ name: 'Jorge Perez' }] },
  { label: 'userIdField', assignees: [{ userId: JORGE_USER_ID }] },
  { label: 'userObject', assignees: [{ user: { id: JORGE_USER_ID } }] },
];

for (const p of partials) {
  const r = await pave({
    createDailyLog: {
      $: { jobId: JOB_12059, date: today, notes: note + ' ' + p.label, files: [], assignees: p.assignees },
      createdDailyLog: { id: {}, user: { id: {}, name: {} } },
    },
  });
  console.log('partial', p.label, S(r));
  out.results.push({
    step: 'createPartial:' + p.label,
    httpStatus: r.httpStatus,
    text: r.text,
    json: r.json,
    mutationAssignees: p.assignees,
    created: r.json?.createDailyLog?.createdDailyLog || null,
  });
}

// If we got an email from selection, retry with real email
let realEmail = null;
for (const r of out.results) {
  if (r.step?.startsWith('emailSel:') && r.json && !r.json._parseError) {
    const u = r.json.user;
    realEmail = u?.emailAddress || u?.email || u?.account?.emailAddress || u?.account?.email || u?.emails?.nodes?.[0]?.address;
    if (realEmail) break;
  }
}
console.log('realEmailFound', Boolean(realEmail), realEmail ? ('len=' + realEmail.length) : '');

if (realEmail) {
  const r = await pave({
    createDailyLog: {
      $: {
        jobId: JOB_12059,
        date: today,
        notes: note + ' REAL_EMAIL',
        files: [],
        assignees: [{ emailAddress: realEmail }],
      },
      createdDailyLog: { id: {}, user: { id: {}, name: {} } },
    },
  });
  console.log('realEmailCreate', S(r));
  out.results.push({
    step: 'create:realEmail',
    httpStatus: r.httpStatus,
    text: r.text,
    json: r.json,
    created: r.json?.createDailyLog?.createdDailyLog || null,
    userIsGrant: r.json?.createDailyLog?.createdDailyLog?.user?.id === grantUserId,
    userIsJorge: r.json?.createDailyLog?.createdDailyLog?.user?.id === JORGE_USER_ID,
    // do not echo email in final dump beyond length
    emailLen: realEmail.length,
  });

  // Also try with id+email
  const r2 = await pave({
    createDailyLog: {
      $: {
        jobId: JOB_12059,
        date: today,
        notes: note + ' REAL_EMAIL_PLUS_ID',
        files: [],
        assignees: [{ emailAddress: realEmail, id: JORGE_USER_ID }],
      },
      createdDailyLog: { id: {}, user: { id: {}, name: {} } },
    },
  });
  console.log('realEmailPlusId', S(r2));
  out.results.push({
    step: 'create:realEmailPlusId',
    httpStatus: r2.httpStatus,
    text: r2.text,
    json: r2.json,
    created: r2.json?.createDailyLog?.createdDailyLog || null,
    userIsGrant: r2.json?.createDailyLog?.createdDailyLog?.user?.id === grantUserId,
    userIsJorge: r2.json?.createDailyLog?.createdDailyLog?.user?.id === JORGE_USER_ID,
  });
}

// After any successful create with assignees, probe more selection fields that might relate
const success = out.results.find((r) => r.created?.id);
if (success?.created?.id) {
  for (const field of ['assignee', 'assignedUser', 'invitedUsers', 'invitees', 'sharedWith', 'watchers', 'followers']) {
    const r = await pave({
      dailyLog: {
        $: { id: success.created.id },
        id: {},
        user: { id: {}, name: {} },
        [field]: { nodes: { id: {}, name: {}, emailAddress: {} } },
      },
    });
    console.log('postSelect', field, S(r));
    out.results.push({ step: 'postSelect:' + field, httpStatus: r.httpStatus, text: r.text, exists: r.ok && !r.json?._parseError });
  }
}

console.log('=== VERDICT TABLE ===');
console.log(JSON.stringify(out, null, 2));
console.log('===PAVE_ASSIGNEE_EMAIL_PROBE_END===');
process.exit(0);