// Seed hook for `qj run --build` (REQ-ENV-04/AC2): runs after the API is ready, with BASE_URL and the
// run marker QAJITSU_RUN. Seeded data carries the marker so it can be told apart from other runs.
const base = process.env.BASE_URL;
const marker = `qj-${process.env.QAJITSU_TICKET ?? "?"}-${process.env.QAJITSU_RUN ?? "?"}`;
const login = await fetch(`${base}/auth/login`, {
  method: "POST",
  body: JSON.stringify({ username: "admin", password: process.env.DEMO_USER_PASSWORD }),
});
if (login.status !== 200) throw new Error(`seed: admin login failed with ${String(login.status)}`);
const { token } = await login.json();
const seeded = await fetch(`${base}/admin/seed`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: JSON.stringify({ marker }),
});
if (seeded.status !== 201) throw new Error(`seed: failed with ${String(seeded.status)}`);
process.stdout.write(`seeded ${marker}\n`);
