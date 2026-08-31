/**
 * Seeds the Northwest Heating & Air demo account into the D1 database behind a
 * running dev server.
 *
 *   npm run dev            # in one terminal
 *   npm run db:seed:local  # in another
 *
 * Pass --reset to wipe and regenerate the demo organization.
 */
const baseUrl = (process.env.ASKTOBOOKED_URL || 'http://localhost:8788').replace(/\/$/, '');
const reset = process.argv.includes('--reset');

const response = await fetch(`${baseUrl}/api/demo/seed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ reset, ...(process.env.DEMO_PASSWORD ? { password: process.env.DEMO_PASSWORD } : {}) })
}).catch(error => {
  console.error(`Could not reach ${baseUrl}. Is "npm run dev" running?`);
  console.error(error.message);
  process.exit(1);
});

const payload = await response.json().catch(() => null);
if (!response.ok || !payload || payload.ok === false) {
  console.error(`Seeding failed (${response.status}):`, payload?.error || 'unknown error', payload?.details || '');
  process.exit(1);
}

console.log(payload.data.seeded ? 'Seeded demo account:' : 'Demo account already present:', payload.data);
console.log(`\nSign in at ${baseUrl}/login.html with:`);
console.log(`  email    ${payload.data.demo_user_email}`);
console.log(`  password ${process.env.DEMO_PASSWORD || 'asktobooked-demo'}`);
