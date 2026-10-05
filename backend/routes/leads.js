/**
 * Leads routes — all protected (mounted after server.js's global
 * authenticateToken, same as routes/social.js's protectedRouter; there's
 * no public/unauthenticated endpoint here since, unlike OAuth callbacks,
 * nothing external ever calls into this file directly — backend/leads/poller.js
 * is what talks to Meta).
 */

const express = require('express');
const ExcelJS = require('exceljs');
const { getSocialClient } = require('../social/db');
const { listUsers } = require('../lib/users');
const { sendPendingDigest } = require('../leads/digest');
const { notifyNewLead } = require('../leads/poller');

const router = express.Router();

const STATUS_VALUES = ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'];
const STATUS_LABEL = {
  new: 'New', contacted: 'Contacted', qualified: 'Qualified',
  proposal: 'Proposal', won: 'Won', lost: 'Lost'
};

// Shared by GET /leads and GET /leads/export so the export always matches
// whatever the table's own filters are currently showing.
function applyLeadFilters(query, { status, assignedTo, campaignId, search, startDate, endDate }) {
  if (status) query = query.eq('status', status);
  if (assignedTo) query = query.eq('assigned_to', assignedTo);
  if (campaignId) query = query.eq('campaign_id', campaignId);
  if (startDate) query = query.gte('created_time', startDate);
  if (endDate) {
    // A bare "YYYY-MM-DD" from a <input type=date> means "through the end
    // of that day" — without this it'd be treated as that day's midnight
    // and silently drop every lead captured on the end date itself.
    const inclusiveEnd = /^\d{4}-\d{2}-\d{2}$/.test(endDate) ? `${endDate}T23:59:59.999Z` : endDate;
    query = query.lte('created_time', inclusiveEnd);
  }
  if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`);
  return query;
}

function requireSocialClient(res) {
  const client = getSocialClient();
  if (!client) {
    res.status(503).json({ error: 'Social Supabase project not configured (SUPABASE_URL_SOCIAL / SUPABASE_KEY_SOCIAL in .env).' });
    return null;
  }
  return client;
}

router.get('/leads', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    const { limit, offset } = req.query;
    let query = applyLeadFilters(
      client.from('leads').select('*', { count: 'exact' }).order('created_time', { ascending: false }),
      req.query
    );

    const pageLimit = Math.min(Number(limit) || 100, 500);
    const pageOffset = Number(offset) || 0;
    query = query.range(pageOffset, pageOffset + pageLimit - 1);

    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ leads: data, total: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Distinct campaigns, for the filter dropdown — leads is the only table
// that knows about campaigns (scheduled_posts/mentions don't), so this
// reads straight off it rather than a separate campaigns table.
router.get('/leads/campaigns', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { data, error } = await client.from('leads').select('campaign_id, campaign_name').not('campaign_id', 'is', null);
  if (error) return res.status(500).json({ error: error.message });

  const seen = new Map();
  for (const row of data || []) seen.set(row.campaign_id, row.campaign_name);
  res.json({ campaigns: Array.from(seen, ([id, name]) => ({ id, name })) });
});

// Full lead export to .xlsx — same filters as GET /leads (status,
// assignedTo, campaignId, search, startDate/endDate) but ignores
// limit/offset and pages through every matching row instead of capping at
// 500, since an export that silently truncates is worse than a slow one.
// Contact/pipeline info, the connected Page/brand, and Campaign Name are
// included, plus one column per distinct Instant-Form question found in
// field_data (forms vary per campaign, so this is a union across the
// exported rows, not a fixed list) — that's the actual "form" content.
// Meta's own ad-tech bookkeeping IDs/names (campaign/ad/adset/form IDs,
// ad name, form name, the Meta leadgen ID) are deliberately left out —
// they're not useful for lead follow-up and just clutter the sheet.
router.get('/leads/export', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    const PAGE_SIZE = 1000;
    const rows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      let query = applyLeadFilters(
        client.from('leads').select('*').order('created_time', { ascending: false }),
        req.query
      );
      query = query.range(offset, offset + PAGE_SIZE - 1);
      const { data, error } = await query;
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE_SIZE) break;
    }

    const userById = new Map(listUsers().map(u => [u.id, u.email]));

    const accountIds = Array.from(new Set(rows.map(r => r.social_account_id).filter(Boolean)));
    let accountById = new Map();
    if (accountIds.length > 0) {
      const { data: accounts } = await client.from('social_accounts').select('id, brand, account_label, platform').in('id', accountIds);
      accountById = new Map((accounts || []).map(a => [a.id, a]));
    }

    // Instant Form questions differ per campaign/form, so the export gets
    // one column per distinct question name actually present, in the
    // order first seen, rather than guessing a fixed question list.
    const questionOrder = [];
    const questionSeen = new Set();
    for (const row of rows) {
      for (const f of row.field_data || []) {
        if (f.name && !questionSeen.has(f.name)) { questionSeen.add(f.name); questionOrder.push(f.name); }
      }
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Infopace Admin Panel';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });

    const baseColumns = [
      { header: 'Full Name', key: 'full_name', width: 22 },
      { header: 'Email', key: 'email', width: 26 },
      { header: 'Phone', key: 'phone', width: 16 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Assigned To', key: 'assigned_to', width: 24 },
      { header: 'Notes', key: 'notes', width: 30 },
      { header: 'Submitted At', key: 'created_time', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
      { header: 'Captured At', key: 'captured_at', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
      { header: 'Brand', key: 'brand', width: 14 },
      { header: 'Platform', key: 'platform', width: 12 },
      { header: 'Page / Account', key: 'account_label', width: 24 },
      { header: 'Campaign Name', key: 'campaign_name', width: 24 }
    ];
    const questionColumns = questionOrder.map((name, i) => ({ header: name, key: `q_${i}`, width: 28 }));
    sheet.columns = [...baseColumns, ...questionColumns];
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

    for (const row of rows) {
      const account = row.social_account_id ? accountById.get(row.social_account_id) : null;
      const record = {
        full_name: row.full_name || '',
        email: row.email || '',
        phone: row.phone || '',
        status: STATUS_LABEL[row.status] || row.status || '',
        assigned_to: row.assigned_to ? (userById.get(row.assigned_to) || row.assigned_to) : 'Unassigned',
        notes: row.notes || '',
        created_time: row.created_time ? new Date(row.created_time) : null,
        captured_at: row.captured_at ? new Date(row.captured_at) : null,
        brand: account ? account.brand : '',
        platform: account ? account.platform : '',
        account_label: account ? account.account_label : '',
        campaign_name: row.campaign_name || ''
      };
      questionOrder.forEach((name, i) => {
        const field = (row.field_data || []).find(f => f.name === name);
        record[`q_${i}`] = field ? (field.values || []).join(', ') : '';
      });
      sheet.addRow(record);
    }

    const suffix = req.query.startDate || req.query.endDate
      ? `_${req.query.startDate || 'start'}_to_${req.query.endDate || 'now'}`
      : '';
    const filename = `leads_export${suffix}.xlsx`.replace(/[^a-zA-Z0-9._-]/g, '_');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status-pipeline counts + a today/conversion headline — the KPI strip
// at the top of the Leads page. One query per status is simpler and
// plenty fast at this table's size rather than a single grouped query
// via Supabase's more awkward .group() support.
router.get('/leads/summary', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  try {
    // "Today" means the IST calendar day, regardless of the server's own
    // timezone (production runs in UTC) — otherwise this boundary drifts
    // by up to 5.5 hours from what the IST-based admin UI calls "today".
    // Computed with UTC getters/Date.UTC throughout so it never depends on
    // the server process's own TZ setting.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const istWallClock = new Date(Date.now() + IST_OFFSET_MS);
    const istMidnightWallMs = Date.UTC(istWallClock.getUTCFullYear(), istWallClock.getUTCMonth(), istWallClock.getUTCDate());
    const todayStart = new Date(istMidnightWallMs - IST_OFFSET_MS);

    const [totalResult, todayResult, ...statusResults] = await Promise.all([
      client.from('leads').select('id', { count: 'exact', head: true }),
      client.from('leads').select('id', { count: 'exact', head: true }).gte('captured_at', todayStart.toISOString()),
      ...STATUS_VALUES.map(status => client.from('leads').select('id', { count: 'exact', head: true }).eq('status', status))
    ]);

    const byStatus = {};
    STATUS_VALUES.forEach((status, i) => { byStatus[status] = statusResults[i].count || 0; });

    const total = totalResult.count || 0;
    const won = byStatus.won || 0;
    const lost = byStatus.lost || 0;
    const decided = won + lost;

    res.json({
      total,
      newToday: todayResult.count || 0,
      byStatus,
      conversionRate: decided > 0 ? Math.round((won / decided) * 1000) / 10 : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/leads/:id', async (req, res) => {
  const client = requireSocialClient(res);
  if (!client) return;

  const { status, assignedTo, notes } = req.body;
  if (status !== undefined && !STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUS_VALUES.join(', ')}` });
  }

  const update = {};
  if (status !== undefined) update.status = status;
  if (assignedTo !== undefined) update.assigned_to = assignedTo || null;
  if (notes !== undefined) update.notes = notes;
  if (Object.keys(update).length === 0) return res.status(400).json({ error: 'Nothing to update — pass status, assignedTo and/or notes.' });

  const { data, error } = await client.from('leads').update(update).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Lead not found.' });
  res.json({ lead: data });
});

// Reuses the same login-accounts roster as the Inbox's assignee dropdown
// (routes/social.js's GET /social/team), narrowed to finance + admin —
// the only roles that can open the Sales module, so assigning a lead to
// anyone else would hand it to someone who can't see it.
router.get('/leads/team', (req, res) => {
  res.json({ users: listUsers().filter(u => u.role === 'finance' || u.role === 'admin') });
});

// Manually trigger the same digest send as
// scripts/backfill-lead-notification-digest.js — exists as an HTTP route
// (rather than only a CLI script) so it's reachable on hosts without
// Shell access, like Render's free tier. Already behind this router's
// requireRole('finance', 'admin') gate (server.js), same as every other
// /leads route.
router.post('/leads/notify-pending', async (req, res) => {
  try {
    const result = await sendPendingDigest({ dryRun: req.query.dryRun === 'true' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin-only: sends the real per-lead "New lead: ..." email (the exact
// function the Meta Lead Ads poller calls) using sample data, so SMTP/
// production delivery can be verified on demand without a real Facebook
// form submission and without writing anything to the leads table. This
// router is already behind requireRole('finance', 'admin') (server.js),
// but this one route is narrowed further to admin only — finance has no
// reason to be testing backend email delivery.
router.post('/leads/test-notify', async (req, res) => {
  const user = listUsers().find(u => u.id === req.user.id);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only.', code: 'FORBIDDEN_ROLE' });
  }

  const sampleLead = {
    full_name: 'Test Lead',
    email: 'test@example.com',
    phone: '+910000000000',
    form_name: 'Test Form (not a real submission)',
    campaign_name: 'Manual admin test',
    ad_name: 'test-notify endpoint',
    created_time: new Date().toISOString(),
    field_data: [{ name: 'note', values: ['Sent via POST /api/leads/test-notify — nothing was written to the leads table.'] }]
  };

  try {
    const sent = await notifyNewLead(sampleLead);
    if (!sent) {
      return res.status(500).json({ error: 'notifyNewLead() returned false — LEADS_NOTIFY_EMAIL or SMTP is not configured in this environment.' });
    }
    res.json({ sent: true, recipients: (process.env.LEADS_NOTIFY_EMAIL || '').split(',').map(s => s.trim()).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
