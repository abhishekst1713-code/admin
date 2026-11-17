/**
 * Mailer for new-lead notifications (backend/leads/poller.js) and the
 * lead digest (backend/leads/digest.js).
 *
 * Two transports behind one sendMail():
 *
 *   1. Microsoft Graph over HTTPS (preferred). infopaceindia.com's mail
 *      is on Microsoft 365, and Render's free web services no longer
 *      allow outbound traffic to SMTP ports 25/465/587 (blocked across
 *      all regions since late Sept 2025), so smtp.office365.com is
 *      simply unreachable from the deployed backend — every connect
 *      hangs until connectionTimeout and fails. Graph talks to the same
 *      mailbox over 443, which is not blocked, and keeps SPF/DKIM
 *      alignment plus a real Sent Items copy because the mail genuinely
 *      originates from support@infopaceindia.com.
 *
 *   2. SMTP via nodemailer (fallback). Still works for local dev and on
 *      hosts that permit outbound SMTP, so it's kept rather than ripped
 *      out — Graph wins whenever its credentials are present.
 *
 * Graph needs an Azure app registration with the *application* (not
 * delegated) Mail.Send permission, admin-consented. Grant it narrowly:
 * by default Mail.Send lets the app send as any mailbox in the tenant,
 * so scope it to the sending mailbox with an ApplicationAccessPolicy.
 */

const nodemailer = require('nodemailer');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const LOGIN_BASE = 'https://login.microsoftonline.com';
const REQUEST_TIMEOUT_MS = 15000;

let cachedTransport = null;
let cachedToken = null; // { value, expiresAt }

function graphConfig() {
  const tenantId = process.env.MS_GRAPH_TENANT_ID;
  const clientId = process.env.MS_GRAPH_CLIENT_ID;
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET;
  // The mailbox Graph sends as. Falls back to the addresses already
  // configured for SMTP so there's no third place to keep the sender in
  // sync — MS_GRAPH_SENDER only needs setting to send as a *different*
  // mailbox than EMAIL_FROM.
  const sender = parseAddress(process.env.MS_GRAPH_SENDER || process.env.EMAIL_FROM || process.env.SMTP_USER || '');
  if (!tenantId || !clientId || !clientSecret || !sender) return null;
  return { tenantId, clientId, clientSecret, sender };
}

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function isConfigured() {
  return !!graphConfig() || isSmtpConfigured();
}

// Pulls the bare address out of either "Name <a@b.com>" or "a@b.com".
// Graph wants the address and the display name as separate JSON fields,
// unlike SMTP headers where one combined string is fine.
function parseAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const bracketed = value.match(/<([^>]+)>/);
  const address = (bracketed ? bracketed[1] : value).trim();
  return address.includes('@') ? address : null;
}

function parseDisplayName(raw) {
  const match = String(raw || '').match(/^\s*"?([^"<]*?)"?\s*</);
  const name = match ? match[1].trim() : '';
  return name || null;
}

// poller.js/digest.js pass `to` as a comma-joined string (SMTP header
// style); Graph needs one recipient object per address.
function toRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(',');
  return list
    .map(parseAddress)
    .filter(Boolean)
    .map(address => ({ emailAddress: { address } }));
}

async function fetchJson(url, options, label) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // A timeout here means HTTPS to Microsoft is failing too, which is a
    // different (and much more alarming) problem than the SMTP block —
    // say which call died so the log isn't ambiguous.
    throw new Error(`${label} failed: ${err.name === 'TimeoutError' ? `no response within ${REQUEST_TIMEOUT_MS}ms` : err.message}`);
  }

  const body = await res.text();
  if (!res.ok) {
    // Graph errors are JSON ({ error: { code, message } }); surface the
    // message rather than a bare status, since the useful part is e.g.
    // "Access denied" vs "mailbox not found" vs an expired secret.
    // The two endpoints disagree on error shape: Graph returns
    // { error: { code, message } }, while Azure AD's token endpoint
    // returns { error: "invalid_client", error_description: "AADSTS..." }
    // — a string, not an object. Handle both, since the AADSTS code is
    // the one that actually names the misconfiguration.
    let detail = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body);
      if (parsed.error && typeof parsed.error === 'object') {
        detail = `${parsed.error.code || res.status}: ${parsed.error.message || detail}`;
      } else if (parsed.error_description) {
        detail = `${parsed.error || res.status}: ${parsed.error_description}`;
      } else if (typeof parsed.error === 'string') {
        detail = parsed.error;
      }
    } catch { /* non-JSON body — the raw text above is the best we have */ }
    throw new Error(`${label} failed (HTTP ${res.status}) ${detail}`);
  }

  return body ? JSON.parse(body) : {};
}

// Client-credentials token, cached until shortly before it expires.
// Tokens last ~1h and the poller sweeps every 5 min, so without caching
// this would be a pointless extra round trip on every single send.
async function getAccessToken(config) {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;

  const form = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const json = await fetchJson(
    `${LOGIN_BASE}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() },
    'Microsoft Graph token request'
  );

  if (!json.access_token) throw new Error('Microsoft Graph token request returned no access_token.');
  // 60s safety margin so a token can't expire mid-flight between this
  // check and the sendMail call that follows it.
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in || 3600) - 60) * 1000 };
  return cachedToken.value;
}

async function sendViaGraph(config, { to, cc, subject, html, text, replyTo }) {
  const recipients = toRecipients(to);
  if (recipients.length === 0) throw new Error('No valid recipients.');
  const ccRecipients = toRecipients(cc);

  const token = await getAccessToken(config);
  const fromName = parseDisplayName(process.env.MS_GRAPH_SENDER || process.env.EMAIL_FROM);
  const replyToAddress = parseAddress(replyTo);

  const message = {
    subject: subject || '',
    // Graph takes a single body, not SMTP's multipart text+html
    // alternative, so prefer the HTML version when a caller supplied
    // both (notifyLeadSubmitter does) and fall back to the plain text.
    body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
    toRecipients: recipients,
    from: { emailAddress: { address: config.sender, ...(fromName ? { name: fromName } : {}) } }
  };
  // CC is visible to the recipient and their Reply All goes to it too.
  // Use BCC instead if a copied address should stay hidden from leads.
  if (ccRecipients.length) message.ccRecipients = ccRecipients;
  if (replyToAddress) message.replyTo = [{ emailAddress: { address: replyToAddress } }];

  await fetchJson(
    `${GRAPH_BASE}/users/${encodeURIComponent(config.sender)}/sendMail`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, saveToSentItems: true })
    },
    'Microsoft Graph sendMail'
  );
}

function getTransport() {
  if (!isSmtpConfigured()) return null;
  if (!cachedTransport) {
    const port = Number(process.env.SMTP_PORT || 587);
    cachedTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // SMTP over implicit TLS; 587/25 use STARTTLS instead, which nodemailer negotiates automatically when secure is false
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Without these, a blocked/unreachable host (Render's free tier
      // blocks outbound 25/465/587 outright) falls back to Node's raw
      // TCP connect timeout — around 2 minutes — per attempt.
      // leads/poller.js retries every pending send on every 5 min
      // sweep, serially, so a dead host would otherwise stall each
      // sweep for minutes instead of failing fast.
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
  }
  return cachedTransport;
}

async function sendMail({ to, cc, subject, html, text, replyTo }) {
  const graph = graphConfig();
  if (graph) return sendViaGraph(graph, { to, cc, subject, html, text, replyTo });

  const transport = getTransport();
  if (!transport) {
    throw new Error(
      'No mail transport configured. Set MS_GRAPH_TENANT_ID / MS_GRAPH_CLIENT_ID / MS_GRAPH_CLIENT_SECRET ' +
      '(preferred — required on Render, which blocks outbound SMTP), or SMTP_HOST / SMTP_USER / SMTP_PASS for local SMTP.'
    );
  }
  const ccHeader = toRecipients(cc).map(r => r.emailAddress.address).join(',');
  await transport.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to,
    ...(ccHeader ? { cc: ccHeader } : {}),
    subject, html, text, replyTo
  });
}

// Which transport sendMail would actually use — handy for a startup log
// line / health check, so "emails aren't arriving" can be told apart
// from "the deploy silently fell back to blocked SMTP".
function activeTransport() {
  if (graphConfig()) return 'microsoft-graph';
  if (isSmtpConfigured()) return 'smtp';
  return 'none';
}

// Proves the transport can authenticate, without sending anything. For
// Graph that's a client-credentials token request, which is where the
// realistic misconfigurations show up (wrong tenant, expired client
// secret, admin consent never granted); for SMTP it's nodemailer's own
// connect+auth probe. Used by GET /leads/mail-check so a deploy can be
// verified from the admin panel rather than by waiting for a real lead.
async function verifyTransport() {
  const graph = graphConfig();
  if (graph) {
    cachedToken = null; // a cached token would make this a no-op and hide a since-expired secret
    await getAccessToken(graph);
    return { transport: 'microsoft-graph', ok: true, sender: graph.sender, detail: 'Access token acquired.' };
  }

  const transport = getTransport();
  if (!transport) return { transport: 'none', ok: false, detail: 'No mail transport configured.' };
  await transport.verify();
  return {
    transport: 'smtp',
    ok: true,
    sender: process.env.SMTP_USER,
    detail: `Connected to ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 587}.`
  };
}

module.exports = { isConfigured, sendMail, activeTransport, verifyTransport };
