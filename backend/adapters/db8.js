const { buildRetentionCohort } = require('./_retention');

/**
 * DB8 Adapter: DPR Generator
 *
 * A Detailed Project Report builder: a promoter fills in a project's
 * cost breakdown and funding mix, and the tool produces the DPR a bank
 * asks for against a loan application.
 *
 * SCHEMA (verified live with the project's service_role key):
 *
 *   users          id, name, email, hashed_password, company, phone,
 *                  service_type, role, created_at, last_login_at
 *   dpr_reports    id, user_id, created_at, updated_at, email,
 *                  business_name, entity_type, state, district, block,
 *                  village, bank_name, report_status,
 *                  total_project_cost, land_cost, building_cost,
 *                  machinery, working_capital, raw_materials,
 *                  other_cost, subsidy, bank_loan,
 *                  promoter_contribution, projections
 *   profiles       id, created_at, updated_at, full_name, phone_number,
 *                  company_name
 *   notifications  id, user_id, created_at, title, message, type,
 *                  is_read, link
 *
 * WHY THE RECORD LIST IS USERS, NOT REPORTS:
 *
 * Every other tool lists its work product. Here there isn't one yet:
 * users holds 482 rows and dpr_reports, profiles and notifications hold
 * zero — confirmed with the service_role key, so that is real emptiness,
 * not RLS hiding rows. 482 people registered and not one has produced a
 * DPR. Listing reports would render an empty table and hide the single
 * most important fact about this tool.
 *
 * So one row = one registered user, with their report count beside them.
 * When reports do start landing, the same list still works and the count
 * column fills in. The drawer shows each user's reports in full.
 *
 * THINGS THIS PROJECT DOES NOT HAVE:
 *
 *  - NO PAYMENT of any kind. No payments/orders/subscriptions/credits
 *    table, no paid flag, no amount column referring to money paid TO
 *    this business. getPaymentSummary is deliberately not exported, so
 *    Payment Monitoring reports the tool as unsupported rather than
 *    inventing a zero. The rupee figures on a report are the
 *    *applicant's own project cost* — not revenue.
 *  - NO SCORE. The panel's record table requires a numeric
 *    score/maxScore, so an engagement stage is mapped onto it (produced
 *    a report / signed in / never signed in). The table itself never
 *    shows that number; it shows the report count and the stage.
 *  - NO FOREIGN KEYS between any of these tables, so PostgREST cannot
 *    embed. Every join below is done in JS off user_id, with one query
 *    per table rather than one per row.
 *  - profiles is keyed by its own id with no FK to users. Whether
 *    profiles.id equals users.id could not be confirmed (zero rows), so
 *    it is joined defensively and only ever used to fill a missing name
 *    or phone, never to decide who something belongs to.
 *
 * STILL UNVERIFIED:
 *  - the real report_status strings, since no report exists. Matched
 *    case-insensitively against families of likely values with a safe
 *    fallback, never against one guessed literal.
 *  - whether the cost columns hold rupees or lakhs. Rendered as plain
 *    rupees; formatInr below is the one place to change if not.
 *  - the siteUrl in metadata.
 */

const TABLES = {
  USERS: 'users',
  REPORTS: 'dpr_reports',
  PROFILES: 'profiles',
  NOTIFICATIONS: 'notifications'
};

const MAX_SCORE = 100;

const USER_SELECT = 'id, name, email, company, phone, service_type, role, created_at, last_login_at';

const REPORT_SELECT = `
  id, user_id, email, business_name, entity_type,
  state, district, block, village, bank_name, report_status,
  total_project_cost, land_cost, building_cost, machinery,
  working_capital, raw_materials, other_cost,
  subsidy, bank_loan, promoter_contribution,
  created_at, updated_at
`;

/* ──────────────────────────── helpers ──────────────────────────── */

function num(value) {
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

/** Indian digit grouping, e.g. 1250000 -> ₹12,50,000. */
function formatInr(amount) {
  return '₹' + Math.round(num(amount)).toLocaleString('en-IN');
}

/** Compact form for a table cell: ₹12.5L / ₹1.25Cr. */
function formatInrShort(amount) {
  const n = Math.round(num(amount));
  if (!n) return '₹0';
  if (n >= 10000000) return '₹' + (n / 10000000).toFixed(2).replace(/\.00$/, '') + 'Cr';
  if (n >= 100000) return '₹' + (n / 100000).toFixed(2).replace(/\.00$/, '') + 'L';
  return formatInr(n);
}

function fmtDate(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * report_status -> stage. Case-insensitive family matching, because no
 * report exists to sample the real strings from. Returns null for an
 * unrecognised value so callers can say "unknown" rather than silently
 * calling it a failure.
 */
function statusBucket(status) {
  const s = String(status || '').toLowerCase().trim();
  if (!s) return null;
  if (/(completed|complete|ready|done|success|succeeded|generated|finished|published|approved)/.test(s)) return 'completed';
  if (/(processing|generating|running|in_progress|inprogress|pending|queued|started|working|submitted)/.test(s)) return 'in_progress';
  if (/(draft|created|new|initialised|initialized|unstarted|incomplete)/.test(s)) return 'draft';
  if (/(failed|failure|error|cancelled|canceled|aborted|timeout|rejected)/.test(s)) return 'failed';
  return null;
}

const BUCKET_LABEL = {
  completed: 'Completed',
  in_progress: 'In progress',
  draft: 'Draft',
  failed: 'Failed'
};

function reportStatusLabel(status) {
  const bucket = statusBucket(status);
  if (!bucket) return status ? `Unrecognized status ("${status}")` : 'No status set';
  return BUCKET_LABEL[bucket];
}

function placeOf(report) {
  return [report.village, report.block, report.district, report.state]
    .map(p => (p || '').trim())
    .filter(Boolean)
    .join(', ') || 'N/A';
}

/**
 * How far a registered user actually got. This is the funnel that
 * matters for this tool, and it stands in for the score the panel's
 * record contract requires.
 */
function engagement(user, reportCount) {
  if (reportCount > 0) {
    return {
      score: 100,
      label: reportCount === 1 ? 'Report generated' : `${reportCount} reports`,
      tone: 'high'
    };
  }
  if (user.last_login_at) {
    return { score: 50, label: 'Signed in, no report', tone: 'medium' };
  }
  return { score: 0, label: 'Never signed in', tone: 'low' };
}

/** The cost side of a DPR, reported as stored — parts are never summed
 *  into the total, because a part-filled form is a normal state and
 *  silently "correcting" it would misrepresent the submission. */
function costBreakdown(report) {
  return [
    { label: 'Land', value: num(report.land_cost) },
    { label: 'Building', value: num(report.building_cost) },
    { label: 'Machinery', value: num(report.machinery) },
    { label: 'Working capital', value: num(report.working_capital) },
    { label: 'Raw materials', value: num(report.raw_materials) },
    { label: 'Other', value: num(report.other_cost) }
  ];
}

function fundingBreakdown(report) {
  return [
    { label: 'Bank loan', value: num(report.bank_loan) },
    { label: 'Promoter contribution', value: num(report.promoter_contribution) },
    { label: 'Subsidy', value: num(report.subsidy) }
  ];
}

/** user_id -> [reports], newest first. */
function reportsByUser(reports) {
  const map = new Map();
  (reports || []).forEach(r => {
    if (!r.user_id) return;
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r);
  });
  map.forEach(list => list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
  return map;
}

/** Best-effort enrichment from profiles — see the header note on why
 *  this is never used to decide ownership. */
async function profileIndex(supabase) {
  const index = new Map();
  try {
    const { data, error } = await supabase
      .from(TABLES.PROFILES)
      .select('id, full_name, phone_number, company_name');
    if (!error) (data || []).forEach(p => index.set(p.id, p));
  } catch (e) {
    /* leave empty */
  }
  return index;
}

function displayName(user, profile) {
  return (!blank(user.name) && user.name)
    || (profile && !blank(profile.full_name) && profile.full_name)
    || (!blank(user.email) && user.email)
    || 'Unknown user';
}

function displayCompany(user, profile) {
  if (!blank(user.company)) return user.company;
  if (profile && !blank(profile.company_name)) return profile.company_name;
  return null;
}

/* ──────────────────────────── adapter ──────────────────────────── */

/**
 * One row per registered user, newest signup first, with the number of
 * DPRs they have produced. See the header for why this is users rather
 * than reports.
 */
async function getCandidates(supabase) {
  const [usersRes, reportsRes, profiles] = await Promise.all([
    supabase.from(TABLES.USERS).select(USER_SELECT).order('created_at', { ascending: false }),
    supabase.from(TABLES.REPORTS).select('id, user_id, created_at, report_status, total_project_cost'),
    profileIndex(supabase)
  ]);

  if (usersRes.error) throw usersRes.error;

  // Reports are secondary: if that table is unreadable, still list the
  // users rather than failing the whole view into mock data.
  if (reportsRes.error) {
    console.warn(`[db8] dpr_reports unreadable, report counts will read 0: ${reportsRes.error.message}`);
  }
  const byUser = reportsByUser(reportsRes.error ? [] : reportsRes.data);

  return (usersRes.data || []).map(user => {
    const profile = profiles.get(user.id);
    const reports = byUser.get(user.id) || [];
    const eng = engagement(user, reports.length);
    const company = displayCompany(user, profile);
    const name = displayName(user, profile);

    return {
      id: String(user.id),
      name: company ? `${name} (${company})` : name,
      email: user.email || 'No Email',
      phone: (!blank(user.phone) && user.phone)
        || (profile && !blank(profile.phone_number) && profile.phone_number)
        || 'N/A',
      testDate: user.created_at,
      score: eng.score,
      maxScore: MAX_SCORE,

      // --- db8-specific row display ---
      scoreLabel: reports.length ? String(reports.length) : '—',
      statusLabel: eng.label,
      statusTone: eng.tone
    };
  });
}

/**
 * A user's full record: their account, how far they got, and every DPR
 * they have filed with its cost and funding breakdown.
 */
async function getCandidateDetails(supabase, candidateId) {
  const { data: user, error } = await supabase
    .from(TABLES.USERS)
    .select(USER_SELECT)
    .eq('id', candidateId)
    .single();

  if (error) throw error;

  const profiles = await profileIndex(supabase);
  const profile = profiles.get(user.id);

  const tryRows = async (table, build) => {
    try {
      const { data, error: err } = await build(supabase.from(table));
      return err ? [] : (data || []);
    } catch (e) {
      return [];
    }
  };

  const reports = await tryRows(TABLES.REPORTS, q => q
    .select(REPORT_SELECT)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false }));

  const notifications = await tryRows(TABLES.NOTIFICATIONS, q => q
    .select('id, title, message, type, is_read, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(5));

  const eng = engagement(user, reports.length);
  const company = displayCompany(user, profile);

  const sections = [
    {
      title: 'Account',
      fields: [
        { label: 'Name', value: displayName(user, profile) },
        { label: 'Email', value: user.email || 'N/A' },
        { label: 'Phone', value: (!blank(user.phone) && user.phone) || (profile && profile.phone_number) || 'N/A' },
        { label: 'Company', value: company || 'N/A' },
        { label: 'Service', value: user.service_type || 'N/A' },
        { label: 'Role', value: user.role || 'N/A' },
        { label: 'User ID', value: String(user.id), mono: true }
      ]
    },
    {
      title: 'Activity',
      fields: [
        { label: 'Status', value: eng.label, tone: eng.tone === 'low' ? 'warning' : eng.tone === 'high' ? 'success' : undefined },
        { label: 'Registered', value: fmtDate(user.created_at) },
        { label: 'Last login', value: user.last_login_at ? fmtDate(user.last_login_at) : 'Never signed in' },
        { label: 'Reports filed', value: String(reports.length) },
        ...(profile ? [{ label: 'Profile record', value: `Present (updated ${fmtDate(profile.updated_at)})` }] : [])
      ]
    }
  ];

  // One section per DPR, so a user with several gets each broken out
  // rather than squashed into one blob.
  if (reports.length) {
    reports.forEach((report, i) => {
      const costs = costBreakdown(report);
      const funding = fundingBreakdown(report);
      const costSum = costs.reduce((s, c) => s + c.value, 0);
      const fundingSum = funding.reduce((s, f) => s + f.value, 0);
      const total = num(report.total_project_cost);

      sections.push({
        title: reports.length > 1 ? `Report ${reports.length - i}: ${report.business_name || 'Unnamed business'}`
                                  : `Report: ${report.business_name || 'Unnamed business'}`,
        fields: [
          { label: 'Status', value: `${reportStatusLabel(report.report_status)}${report.report_status ? ` (${report.report_status})` : ''}` },
          { label: 'Entity type', value: report.entity_type || 'N/A' },
          { label: 'Location', value: placeOf(report) },
          { label: 'Bank', value: report.bank_name || 'N/A' },
          { label: 'Email on report', value: report.email || 'N/A' },
          { label: 'Created', value: fmtDate(report.created_at) },
          { label: 'Last updated', value: fmtDate(report.updated_at) },

          { label: 'Total project cost', value: formatInr(total), tone: total ? 'success' : undefined },
          ...costs.map(c => ({ label: `  ${c.label}`, value: formatInr(c.value) })),
          ...(total && costSum && Math.abs(costSum - total) > 1
            ? [{ label: '  Components total', value: `${formatInr(costSum)} — does not match the stored total`, tone: 'warning' }]
            : []),

          ...funding.map(f => ({ label: f.label, value: formatInr(f.value) })),
          ...(total && fundingSum && Math.abs(fundingSum - total) > 1
            ? [{ label: 'Funding gap', value: `${formatInr(total - fundingSum)} of the project cost is not covered`, tone: 'warning' }]
            : []),

          ...(report.projections
            ? [{
                label: 'Projections',
                value: typeof report.projections === 'string'
                  ? report.projections.slice(0, 3000)
                  : JSON.stringify(report.projections, null, 2).slice(0, 3000)
              }]
            : []),
          { label: 'Report ID', value: String(report.id), mono: true }
        ]
      });
    });
  } else {
    sections.push({
      title: 'Reports',
      fields: [{
        label: 'Status',
        value: 'This user has not produced a DPR. No report rows exist for them.',
        tone: 'warning'
      }]
    });
  }

  sections.push({
    title: 'Notifications',
    fields: notifications.length
      ? notifications.map(n => ({
          label: fmtDate(n.created_at).slice(0, 10),
          value: `${n.title || n.type || 'Notification'}${n.message ? `\n${n.message}` : ''}`,
          tone: n.is_read === false ? 'warning' : undefined
        }))
      : [{ label: 'Status', value: 'No notifications for this user.' }]
  });

  return {
    personalInfo: {
      id: String(user.id),
      name: displayName(user, profile),
      email: user.email || 'No Email',
      testDate: user.created_at,
      score: eng.score,
      maxScore: MAX_SCORE,
      sessionId: String(user.id),
      screenshotUrl: null
    },
    sections,
    results: sections.map(sec => ({
      question: sec.title,
      answer: sec.fields.map(f => `${f.label}: ${f.value}`).join('\n'),
      score: null,
      maxScore: null
    }))
  };
}

async function getUserBreakdown(supabase) {
  const [usersRes, reportsRes] = await Promise.all([
    supabase.from(TABLES.USERS).select('id, name, email, company, created_at, last_login_at'),
    supabase.from(TABLES.REPORTS).select('id, user_id, created_at, report_status')
  ]);

  if (usersRes.error) throw usersRes.error;
  const byUser = reportsByUser(reportsRes.error ? [] : reportsRes.data);

  const users = (usersRes.data || []).map(u => {
    const reports = byUser.get(u.id) || [];
    const eng = engagement(u, reports.length);
    const lastReport = reports.length ? reports[0].created_at : null;
    const lastActivity = [u.last_login_at, lastReport, u.created_at]
      .filter(Boolean)
      .sort((a, b) => new Date(b) - new Date(a))[0] || null;
    return {
      userId: String(u.id),
      name: displayName(u, null),
      // "attempts" in the panel's contract — here, DPRs produced.
      attempts: reports.length,
      averageScore: eng.score,
      lastActivity
    };
  });

  const totalReports = users.reduce((s, u) => s + u.attempts, 0);

  return {
    totalUniqueUsers: users.length,
    averageAttemptsPerUser: users.length > 0
      ? Math.round((totalReports / users.length) * 10) / 10
      : 0,
    users: users.sort((a, b) =>
      b.attempts - a.attempts ||
      new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0))
  };
}

/**
 * Grouped by the company a user typed at signup. Only a fraction fill it
 * in, so the blank bucket is labelled honestly rather than dropped — a
 * silent omission would make the column look more complete than it is.
 */
async function getOrgBreakdown(supabase) {
  const [usersRes, reportsRes] = await Promise.all([
    supabase.from(TABLES.USERS).select('id, company, created_at, last_login_at'),
    supabase.from(TABLES.REPORTS).select('id, user_id')
  ]);

  if (usersRes.error) throw usersRes.error;
  const byUser = reportsByUser(reportsRes.error ? [] : reportsRes.data);

  const orgMap = {};
  (usersRes.data || []).forEach(u => {
    const key = blank(u.company) ? 'Not provided' : String(u.company).trim();
    if (!orgMap[key]) {
      orgMap[key] = { organization: key, totalAssessments: 0, scoreSum: 0, lastActivity: null };
    }
    const reports = byUser.get(u.id) || [];
    orgMap[key].totalAssessments++;
    orgMap[key].scoreSum += engagement(u, reports.length).score;
    const activity = u.last_login_at || u.created_at;
    if (activity) {
      const d = new Date(activity);
      if (!orgMap[key].lastActivity || d > new Date(orgMap[key].lastActivity)) {
        orgMap[key].lastActivity = activity;
      }
    }
  });

  return Object.values(orgMap).map(org => ({
    organization: org.organization,
    totalAssessments: org.totalAssessments,
    averageScore: Math.round(org.scoreSum / org.totalAssessments),
    lastActivity: org.lastActivity
  })).sort((a, b) => b.totalAssessments - a.totalAssessments);
}

async function getRetentionCohort(supabase) {
  const { data, error } = await supabase
    .from(TABLES.USERS)
    .select('id, created_at');

  if (error) throw error;
  // Cohort on the user's own id: one "event" per registration. Once
  // reports exist this should move to dpr_reports, which is what repeat
  // usage actually looks like for this tool.
  return buildRetentionCohort(data, 'id', 'created_at');
}

/*
 * NOT EXPORTED, deliberately:
 *   getPaymentSummary    — this project records no payment at all (see
 *                          the header). Payment Monitoring shows the
 *                          tool as unsupported rather than a fake zero.
 *   getDimensionAverages — there are no sub-scores to average.
 */

function getMockCandidates() {
  return [
    { id: 'db8-user-1', name: 'Ramesh Kumar (Sree Agro Foods)', email: 'ramesh@sreeagro.in', phone: '+91 98450 11223', testDate: '2026-11-15T10:10:00Z', score: 100, maxScore: 100, scoreLabel: '2', statusLabel: '2 reports', statusTone: 'high' },
    { id: 'db8-user-2', name: 'Lakshmi Devi (Devi Handlooms)', email: 'lakshmi@devihandlooms.in', phone: '+91 90000 44556', testDate: '2026-11-13T08:40:00Z', score: 50, maxScore: 100, scoreLabel: '—', statusLabel: 'Signed in, no report', statusTone: 'medium' },
    { id: 'db8-user-3', name: 'Imran Shaikh', email: 'imran@shaikhdairy.in', phone: 'N/A', testDate: '2026-11-10T15:05:00Z', score: 0, maxScore: 100, scoreLabel: '—', statusLabel: 'Never signed in', statusTone: 'low' }
  ];
}

function getMockCandidateDetails(candidateId) {
  const candidates = getMockCandidates();
  const personalInfo = candidates.find(c => c.id === candidateId) || candidates[0];

  const sections = [
    {
      title: 'Account',
      fields: [
        { label: 'Name', value: 'Ramesh Kumar' },
        { label: 'Email', value: 'ramesh@sreeagro.in' },
        { label: 'Phone', value: '+91 98450 11223' },
        { label: 'Company', value: 'Sree Agro Foods' },
        { label: 'Service', value: 'Bank Loan DPR' },
        { label: 'Role', value: 'PROMOTER' },
        { label: 'User ID', value: 'db8-user-1', mono: true }
      ]
    },
    {
      title: 'Activity',
      fields: [
        { label: 'Status', value: '2 reports', tone: 'success' },
        { label: 'Registered', value: '2026-10-30 07:12 UTC' },
        { label: 'Last login', value: '2026-11-15 10:02 UTC' },
        { label: 'Reports filed', value: '2' }
      ]
    },
    {
      title: 'Report 2: Sree Agro Foods',
      fields: [
        { label: 'Status', value: 'Completed (ready)' },
        { label: 'Entity type', value: 'Proprietorship' },
        { label: 'Location', value: 'Hubballi, Dharwad, Karnataka' },
        { label: 'Bank', value: 'Canara Bank' },
        { label: 'Created', value: '2026-11-15 10:10 UTC' },
        { label: 'Total project cost', value: '₹24,50,000', tone: 'success' },
        { label: '  Land', value: '₹0' },
        { label: '  Building', value: '₹6,00,000' },
        { label: '  Machinery', value: '₹12,00,000' },
        { label: '  Working capital', value: '₹4,50,000' },
        { label: '  Raw materials', value: '₹1,50,000' },
        { label: '  Other', value: '₹50,000' },
        { label: 'Bank loan', value: '₹17,15,000' },
        { label: 'Promoter contribution', value: '₹2,45,000' },
        { label: 'Subsidy', value: '₹4,90,000' },
        { label: 'Report ID', value: 'db8-rep-1', mono: true }
      ]
    },
    {
      title: 'Notifications',
      fields: [{ label: 'Status', value: 'No notifications for this user.' }]
    }
  ];

  return {
    personalInfo: { ...personalInfo, name: personalInfo.name.split(' (')[0], sessionId: personalInfo.id, screenshotUrl: null },
    sections,
    results: sections.map(sec => ({
      question: sec.title,
      answer: sec.fields.map(f => `${f.label}: ${f.value}`).join('\n'),
      score: null,
      maxScore: null
    }))
  };
}

module.exports = {
  getCandidates,
  getCandidateDetails,
  getMockCandidates,
  getMockCandidateDetails,
  getUserBreakdown,
  getOrgBreakdown,
  getRetentionCohort,
  metadata: {
    name: 'DPR Generator',
    category: 'Product',
    // UNVERIFIED: no DPR host was discoverable from the Supabase project.
    // This drives the uptime check in GET /api/health — correct it once
    // the real domain is known.
    siteUrl: 'https://dpr.infopaceindia.com',
    description: 'Detailed Project Report builder for bank loan applications — registered promoters, and the cost and funding breakdown of each DPR they file.',
    candidateColumns: {
      name: 'User & Company',
      score: 'Reports',
      status: 'Activity',
      // No transcript to export for a DPR user record.
      showPdf: false,
      subtitle: 'Registered promoters, how far each got, and the DPRs they have filed.'
    },
    detailView: {
      title: 'User & Report Details',
      loadingText: 'Fetching user record...',
      dateLabel: 'Registered',
      showScore: false,
      showPdf: false
    }
  }
};
