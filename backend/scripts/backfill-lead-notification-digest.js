/**
 * One-off backfill for leads captured before the internal new-lead email
 * ever worked (SMTP was a placeholder password until this was fixed —
 * see backend/.env) — the team was never actually told about them.
 * Rather than send one "New lead: ..." email per lead (90+ emails each,
 * for every address in LEADS_NOTIFY_EMAIL), this sends ONE digest email
 * listing every lead that hasn't been internally notified yet.
 *
 * Shares its send/update logic with routes/leads.js's POST
 * /leads/notify-pending (see backend/leads/digest.js) — that HTTP route
 * exists because this CLI script needs Shell access to run against a
 * deployed backend, which isn't available on Render's free tier.
 *
 * Usage: node backend/scripts/backfill-lead-notification-digest.js
 *        node backend/scripts/backfill-lead-notification-digest.js --dry-run
 * --dry-run builds the digest and prints it (recipients, lead count, the
 * text body) without sending anything or touching the database — use it
 * to sanity-check content/count first.
 * Safe to re-run — only touches rows where internal_notify_sent is false.
 */

require('dotenv').config();
const { sendPendingDigest } = require('../leads/digest');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = await sendPendingDigest({ dryRun });

  if (result.message) {
    console.log(result.message);
    return;
  }

  if (dryRun) {
    console.log(`[dry run] Would send to: ${result.recipients.join(', ')}`);
    console.log(`[dry run] Subject: ${result.subject}`);
    console.log(`[dry run] Lead count: ${result.count}`);
    console.log('[dry run] ---- text body ----');
    console.log(result.text);
    console.log('[dry run] Nothing sent, nothing updated.');
    return;
  }

  console.log(`Sent one digest covering ${result.count} lead(s) to: ${result.recipients.join(', ')}`);
  console.log(`Marked internal_notify_sent = true for ${result.count} lead(s).`);
}

main().catch(err => { console.error('Backfill failed:', err.message); process.exit(1); });
