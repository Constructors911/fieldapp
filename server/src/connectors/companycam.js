// CompanyCam API connector. Active when COMPANYCAM_TOKEN is set.
// Sign-in user linking + daily-log photo pull (see 02-companycam-connector.md).
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

  const uriOf = (photo, type) =>
    (photo.uris || []).find((u) => u.type === type)?.uri
    ?? (photo.uris || [])[0]?.uri
    ?? null;

  return {
    /**
     * Match a JobTread job to a CompanyCam project: search by job name, then
     * by street address. Returns {id, name} | null.
     */
    async findProjectForJob({ jobName, address }) {
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const street = norm(String(address || '').split(',')[0]);
      for (const q of [jobName, street].filter(Boolean)) {
        let results;
        try {
          results = await cc(`/projects?query=${encodeURIComponent(q)}&per_page=25`);
        } catch {
          continue;
        }
        if (!Array.isArray(results)) continue;
        const exact = results.find((p) => norm(p.name) === norm(jobName));
        if (exact) return { id: String(exact.id), name: exact.name };
        const byStreet = street && results.find((p) => norm(p.address?.street_address_1) === street);
        if (byStreet) return { id: String(byStreet.id), name: byStreet.name };
        if (results.length === 1) return { id: String(results[0].id), name: results[0].name };
      }
      return null;
    },

    /** Photos on a CC project, newest first. Returns light objects for the picker. */
    async listProjectPhotos(projectId, { page = 1, perPage = 50 } = {}) {
      const photos = await cc(`/projects/${projectId}/photos?per_page=${perPage}&page=${page}`);
      return (Array.isArray(photos) ? photos : []).map((p) => ({
        id: String(p.id),
        capturedAt: p.captured_at ? new Date(p.captured_at * 1000).toISOString() : null,
        creatorId: p.creator_id != null ? String(p.creator_id) : null,
        creatorName: p.creator_name ?? null,
        thumbnail: uriOf(p, 'thumbnail'),
        web: uriOf(p, 'web'),
      }));
    },

    /** Download a photo's original bytes. Returns {buffer, type, name}. */
    async getPhotoOriginal(photoId) {
      const photo = await cc(`/photos/${photoId}`);
      const uri = uriOf(photo, 'original') || uriOf(photo, 'web');
      if (!uri) throw new Error('CompanyCam photo has no downloadable uri');
      const res = await fetch(uri);
      if (!res.ok) throw new Error(`CompanyCam photo download failed (${res.status})`);
      const buffer = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || 'image/jpeg';
      const ext = type.includes('png') ? 'png' : 'jpg';
      return { buffer, type, name: `companycam-${photoId}.${ext}` };
    },
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
