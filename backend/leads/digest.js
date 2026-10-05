/**
 * Shared by scripts/backfill-lead-notification-digest.js (CLI) and
 * routes/leads.js's POST /leads/notify-pending (an admin/finance-only
 * HTTP trigger for the same thing — added because Render's free tier
 * has no Shell access to run the CLI script directly against
 * production, so this needs to be reachable over HTTP too).
 */

const { getSocialClient } = require('../social/db');
const email = require('../lib/email');

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildDigest(leads) {
  const rows = leads.map(l => ({
    date: l.created_time ? new Date(l.created_time).toLocaleString() : '—',
    name: l.full_name || '—',
    email: l.email || '—',
    phone: l.phone || '—',
    source: l.campaign_name || l.form_name || '—',
    status: l.status || 'new'
  }));

  const subject = `Lead digest: ${leads.length} lead${leads.length === 1 ? '' : 's'} awaiting internal review`;

  const text = [
    `${leads.length} lead(s) captured in the admin panel hadn't triggered an internal notification yet (this is a catch-up, not a sign new leads are being missed going forward).`,
    '',
    ...rows.map((r, i) => [
      `${i + 1}. ${r.name}`,
      `   Email: ${r.email}`,
      `   Phone: ${r.phone}`,
      `   Source: ${r.source}`,
      `   Status: ${r.status}`,
      `   Submitted: ${r.date}`
    ].join('\n')),
    '',
    'Open the Leads section in the admin panel to follow up.'
  ].join('\n');

  const html = `
    <p>${leads.length} lead(s) captured in the admin panel hadn't triggered an internal notification yet (this is a catch-up, not a sign new leads are being missed going forward).</p>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
      <thead>
        <tr style="background:#f2f2f2">
          <th>Name</th><th>Email</th><th>Phone</th><th>Source</th><th>Status</th><th>Submitted</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `<tr>
          <td>${escapeHtml(r.name)}</td>
          <td>${escapeHtml(r.email)}</td>
          <td>${escapeHtml(r.phone)}</td>
          <td>${escapeHtml(r.source)}</td>
          <td>${escapeHtml(r.status)}</td>
          <td>${escapeHtml(r.date)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
    <p>Open the Leads section in the admin panel to follow up.</p>
  `;

  return { subject, text, html };
}

// Sends one digest covering every lead with internal_notify_sent = false,
// then marks exactly the leads that were in that successfully-sent digest
// as notified — same all-or-nothing guarantee as the CLI script this was
// extracted from (a failed send leaves every row untouched, safe to retry).
async function sendPendingDigest({ dryRun = false } = {}) {
  const client = getSocialClient();
  if (!client) throw new Error('Social Supabase project not configured.');

  const recipients = (process.env.LEADS_NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (recipients.length === 0) throw new Error('LEADS_NOTIFY_EMAIL is not set — nothing to send to.');
  if (!email.isConfigured()) throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS).');

  const { data: leads, error } = await client
    .from('leads')
    .select('*')
    .eq('internal_notify_sent', false)
    .order('created_time', { ascending: false });
  if (error) throw new Error(`Could not read leads: ${error.message}`);

  if (!leads || leads.length === 0) {
    return { sent: false, count: 0, message: 'Nothing to do — every lead already has internal_notify_sent = true.' };
  }

  const { subject, text, html } = buildDigest(leads);

  if (dryRun) {
    return { sent: false, count: leads.length, dryRun: true, recipients, subject, text };
  }

  await email.sendMail({ to: recipients.join(','), subject, text, html });

  const now = new Date().toISOString();
  const { error: updateError } = await client
    .from('leads')
    .update({ internal_notify_sent: true, notified_at: now })
    .in('id', leads.map(l => l.id));
  if (updateError) {
    throw new Error(`Digest sent but marking internal_notify_sent failed — fix and re-run will re-send the whole digest: ${updateError.message}`);
  }

  return { sent: true, count: leads.length, recipients };
}

module.exports = { buildDigest, sendPendingDigest };
