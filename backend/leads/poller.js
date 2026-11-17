/**
 * Meta Lead Ads capture — same "plain setInterval sweep" shape as
 * social/pollers.js's inbound sync, not BullMQ (there's no per-item
 * retry/ordering need here, just "try again next sweep" on failure).
 *
 * Every active Facebook social_accounts row gets its leadgen forms
 * polled every POLL_INTERVAL_MS; genuinely new leads (not already in the
 * `leads` table, checked by leadgen_id before inserting so a re-poll of
 * already-seen leads is a no-op) get inserted and trigger two emails via
 * backend/lib/email.js: an internal alert to LEADS_NOTIFY_EMAIL
 * (notifyNewLead) and, separately, a short acknowledgement sent straight
 * to the person who filled the form (notifyLeadSubmitter) — skipped if
 * the form didn't collect an email address. The two are independent: one
 * failing (bad address, SMTP hiccup) never blocks the other. Instagram
 * doesn't need its own sweep here — Instant Form leads are a Page-owned
 * asset regardless of which placement the ad ran on, so facebook.js's
 * fetchLeads() already covers both (see that file's header).
 */

const { getSocialClient } = require('../social/db');
const { getUsableAccount } = require('../social/accounts');
const email = require('../lib/email');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // leads are time-sensitive for sales follow-up — tighter than the 10 min mentions/inbox cadence
let intervalHandle = null;
// setInterval fires on a fixed clock regardless of whether the previous
// sweep finished. retryPendingNotifications is serial over up to 200
// leads, and a dead mail transport costs a full connect timeout per
// send, so a sweep can easily outlast the 5 min interval and stack
// overlapping copies of itself — each re-sending the same pending
// leads. One sweep at a time; a tick that lands mid-sweep is dropped,
// since the next one is only 5 min out anyway.
let sweeping = false;

// Guards against non-address junk ending up in the email field (e.g. a
// test submission with placeholder text) — without this, sendMail's "No
// recipients defined" rejection gets retried and logged every sweep
// forever, since that failure never flips lead_ack_sent to true.
function isValidEmail(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function formatFieldData(fieldData) {
  return (fieldData || [])
    .map(f => `${f.name}: ${(f.values || []).join(', ')}`)
    .join('\n');
}

// A bare generic-text email with no sender identity/footer is exactly the
// shape spam filters flag, especially across many different external
// recipient domains (Gmail/Yahoo/Outlook) rather than one internal tenant.
// Pulls the display name/domain straight out of EMAIL_FROM so there's no
// separate "company name" env var to keep in sync.
function getSenderIdentity() {
  // Same precedence lib/email.js uses to pick the sending mailbox, so the
  // name/domain quoted in the body can't drift from the address the mail
  // actually comes from.
  const raw = process.env.EMAIL_FROM || process.env.MS_GRAPH_SENDER || process.env.SMTP_USER || '';
  const match = raw.match(/^(.*?)<(.+@(.+))>$/);
  if (match) return { name: match[1].trim() || 'Infopace', domain: match[3].trim() };
  const domain = raw.includes('@') ? raw.split('@')[1] : 'infopaceindia.com';
  return { name: 'Infopace', domain };
}

// Returns true only once email.sendMail() has actually confirmed the
// send; false when there was simply nothing to send to (no recipients
// configured, SMTP not set up) — never thrown as an error since that
// case is expected/opt-in. A genuine send failure (bad SMTP login,
// rejected address, etc.) still throws, for the caller to catch and
// record as false.
async function notifyNewLead(lead) {
  const recipients = (process.env.LEADS_NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean);
  if (recipients.length === 0 || !email.isConfigured()) return false; // notification is best-effort/opt-in — the lead itself is already saved either way

  const subject = `New lead: ${lead.full_name || lead.email || lead.phone || 'Untitled'} (${lead.campaign_name || lead.form_name || 'Meta Lead Ad'})`;
  const text = [
    `A new lead came in from ${lead.form_name || 'a Meta Lead Ad form'}.`,
    '',
    `Name: ${lead.full_name || '—'}`,
    `Email: ${lead.email || '—'}`,
    `Phone: ${lead.phone || '—'}`,
    `Campaign: ${lead.campaign_name || '—'}`,
    `Ad: ${lead.ad_name || '—'}`,
    `Submitted: ${lead.created_time || '—'}`,
    '',
    'All answers:',
    formatFieldData(lead.field_data),
    '',
    'Open the Leads section in the admin panel to follow up.'
  ].join('\n');

  await email.sendMail({ to: recipients.join(','), subject, text });
  return true;
}

// Short acknowledgement straight to the person who submitted the form —
// separate concern from notifyNewLead above (that one's the internal
// sales alert). Returns false (not an error) when the form didn't
// collect an email (phone-only forms) or SMTP isn't configured — the
// lead is already saved either way; only a genuine send failure throws.
async function notifyLeadSubmitter(lead) {
  if (!lead.email || !isValidEmail(lead.email) || !email.isConfigured()) return false;

  const { name: senderName, domain } = getSenderIdentity();
  const firstName = (lead.full_name || '').trim().split(/\s+/)[0];
  const subject = `Thank You for Contacting ${senderName}`;

  const text = [
    `Dear ${firstName || lead.full_name || 'there'},`,
    '',
    `Thank you for reaching out to ${senderName}. We have received your details, and a member of our team will contact you shortly to discuss your requirements further.`,
    '',
    'Warm regards,',
    `Team ${senderName}`,
    `https://${domain}`
  ].join('\n');

  // A real footer (name, domain, physical-looking signature) instead of
  // a bare two-line message — reduces the chance Gmail/Yahoo/Outlook spam
  // filters flag this as generic bulk mail, since it's going to many
  // different external domains rather than one internal tenant.
  // Deliberately doesn't name the campaign/form (lead.campaign_name /
  // lead.form_name) — those are internal ad-ops labels (e.g. versioned
  // campaign codenames), not something a customer should see quoted back
  // to them.
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.5;max-width:520px;">`,
    `<p>Dear ${escapeHtml(firstName || lead.full_name || 'there')},</p>`,
    `<p>Thank you for reaching out to <strong>${escapeHtml(senderName)}</strong>. We have received your details, and a member of our team will contact you shortly to discuss your requirements further.</p>`,
    `<p style="margin-top:24px;">Warm regards,<br/>Team ${escapeHtml(senderName)}<br/>`,
    `<a href="https://${domain}" style="color:#0b5fff;">${domain}</a></p>`,
    `</div>`
  ].join('');

  // LEADS_ACK_CC copies an internal address on every acknowledgement
  // that goes back to a lead, so that team sees the enquiry as it lands
  // without waiting for the sales handover. Comma-separate for several.
  // NOTE: this is a visible CC — the lead sees the address and a Reply
  // All reaches it. Switch to BCC if it should stay hidden from them.
  await email.sendMail({
    to: lead.email,
    cc: process.env.LEADS_ACK_CC || '',
    subject, text, html,
    replyTo: process.env.EMAIL_FROM || process.env.MS_GRAPH_SENDER || process.env.SMTP_USER
  });
  return true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function pollAccount(client, row) {
  const usable = await getUsableAccount(row.id);
  if (!usable) return; // account row vanished between the list query and here
  const { account, adapter } = usable;
  if (typeof adapter.fetchLeads !== 'function') return;

  const fetched = await adapter.fetchLeads(account);
  if (fetched.length === 0) return;

  const { data: existing, error: existingError } = await client
    .from('leads')
    .select('leadgen_id')
    .eq('social_account_id', account.id)
    .in('leadgen_id', fetched.map(l => l.externalId));
  if (existingError) throw existingError;

  const existingIds = new Set((existing || []).map(r => r.leadgen_id));
  const newLeads = fetched.filter(l => !existingIds.has(l.externalId));
  if (newLeads.length === 0) return;

  const rows = newLeads.map(l => ({
    social_account_id: account.id,
    leadgen_id: l.externalId,
    form_id: l.formId,
    form_name: l.formName,
    campaign_id: l.campaignId,
    campaign_name: l.campaignName,
    adset_id: l.adsetId,
    ad_id: l.adId,
    ad_name: l.adName,
    full_name: l.fullName,
    email: l.email,
    phone: l.phone,
    field_data: l.fieldData,
    created_time: l.createdTime
  }));

  const { data: inserted, error: insertError } = await client.from('leads').insert(rows).select();
  if (insertError) throw insertError;

  for (const lead of inserted || []) {
    // internal_notify_sent / lead_ack_sent (migrations/005_leads_mail_status.sql)
    // start false on every row and only ever get flipped to true right
    // here, after sendMail has actually confirmed the send — an error
    // (or simply nothing to send to) leaves the column false, never left
    // stale or ambiguous.
    let internalNotifySent = false;
    try {
      internalNotifySent = await notifyNewLead(lead);
    } catch (err) {
      console.error(`[leads/poller] Could not send internal notification for lead ${lead.id}:`, err.message);
    }

    let leadAckSent = false;
    try {
      leadAckSent = await notifyLeadSubmitter(lead);
    } catch (err) {
      console.error(`[leads/poller] Could not send acknowledgement email to lead ${lead.id} (${lead.email}):`, err.message);
    }

    const statusUpdate = { internal_notify_sent: internalNotifySent, lead_ack_sent: leadAckSent };
    if (internalNotifySent) statusUpdate.notified_at = new Date().toISOString();
    const { error: statusError } = await client.from('leads').update(statusUpdate).eq('id', lead.id);
    if (statusError) console.error(`[leads/poller] Could not record mail status for lead ${lead.id}:`, statusError.message);
  }
}

// Leads whose internal/ack email failed last time (bad SMTP login,
// transient network block, etc.) never come back through pollAccount —
// its dedup is by leadgen_id already in the table, not by notify status.
// Without this, a failure here is permanent until someone notices in
// Supabase and manually calls POST /leads/notify-pending. This retries
// both emails, independently, every sweep (5 min) until each succeeds —
// same "try again next sweep" shape as the rest of this poller. A lead
// with no captured email legitimately never gets lead_ack_sent = true;
// that's cheap to keep re-checking at this volume.
async function retryPendingNotifications(client) {
  const { data: pending, error } = await client
    .from('leads')
    .select('*')
    .or('internal_notify_sent.eq.false,lead_ack_sent.eq.false')
    .order('created_time', { ascending: true })
    .limit(200);
  if (error) {
    console.error('[leads/poller] Could not list leads pending notification:', error.message);
    return;
  }

  for (const lead of pending || []) {
    const update = {};

    if (!lead.internal_notify_sent) {
      try {
        if (await notifyNewLead(lead)) {
          update.internal_notify_sent = true;
          update.notified_at = new Date().toISOString();
        }
      } catch (err) {
        console.error(`[leads/poller] Retry: could not send internal notification for lead ${lead.id}:`, err.message);
      }
    }

    if (!lead.lead_ack_sent) {
      try {
        if (await notifyLeadSubmitter(lead)) update.lead_ack_sent = true;
      } catch (err) {
        console.error(`[leads/poller] Retry: could not send acknowledgement email to lead ${lead.id} (${lead.email}):`, err.message);
      }
    }

    if (Object.keys(update).length === 0) continue;
    const { error: updateError } = await client.from('leads').update(update).eq('id', lead.id);
    if (updateError) console.error(`[leads/poller] Could not record retried mail status for lead ${lead.id}:`, updateError.message);
  }
}

async function sweep() {
  const client = getSocialClient();
  if (!client) return; // social project not configured — nothing to poll yet

  if (sweeping) {
    console.warn('[leads/poller] Previous sweep still running — skipping this tick.');
    return;
  }
  sweeping = true;

  try {
    const { data: accounts, error } = await client
      .from('social_accounts')
      .select('id, platform')
      .eq('platform', 'facebook')
      .eq('status', 'active');
    if (error) {
      console.error('[leads/poller] Could not list active Facebook accounts:', error.message);
      return;
    }

    for (const row of accounts || []) {
      await pollAccount(client, row).catch(err => console.error(`[leads/poller] Unexpected failure polling account ${row.id}:`, err.message));
    }

    await retryPendingNotifications(client).catch(err => console.error('[leads/poller] Retry pass failed:', err.message));
  } finally {
    sweeping = false;
  }
}

function start() {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => { sweep().catch(err => console.error('[leads/poller] sweep failed:', err.message)); }, POLL_INTERVAL_MS);
  sweep().catch(err => console.error('[leads/poller] initial sweep failed:', err.message));
  // Names the transport up front so "lead emails aren't arriving" can be
  // diagnosed from the first lines of the deploy log — in particular,
  // 'smtp' on Render means outbound mail is being dropped by the
  // platform's SMTP port block and Graph credentials are missing.
  console.log(`[leads/poller] Meta Lead Ads sync started (5 min interval). Mail transport: ${email.activeTransport()}.`);
}

function stop() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = { start, stop, sweep, notifyNewLead, notifyLeadSubmitter };
