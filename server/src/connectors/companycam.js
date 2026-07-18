// CompanyCam API connector. Active when COMPANYCAM_TOKEN is set.
// v1 scope: user lookup for sign-in linking (photos filtered per user later —
// see ../../..//02-companycam-connector.md for the full connector design).
const CC_BASE = 'https://api.companycam.com/v2';

export function createCompanyCam(env = process.env) {
  const token = env.COMPANYCAM_TOKEN;
  if (!token) return null;

  async function cc(path) {
    const res = await fetch(`${CC_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`CompanyCam ${path} failed (${res.status})`);
    return res.json();
  }

  return {
    /** Best-effort: find a CompanyCam user by email. Returns {id, name} | null. */
    async findUserByEmail(email) {
      const target = String(email).toLowerCase();
      for (let page = 1; page <= 5; page++) {
        const users = await cc(`/users?per_page=100&page=${page}`);
        if (!Array.isArray(users) || users.length === 0) break;
        const u = users.find((x) => String(x.email_address || '').toLowerCase() === target);
        if (u) {
          return { id: String(u.id), name: [u.first_name, u.last_name].filter(Boolean).join(' ') };
        }
        if (users.length < 100) break;
      }
      return null;
    },
  };
}
