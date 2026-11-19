const { buildRetentionCohort } = require('./_retention');

/**
 * DB8 Adapter: DPR Generator  (https://dpr.infopaceindia.com)
 *
 * A Detailed Project Report builder: a promoter fills a ~146-field wizard
 * describing a project's cost, funding mix, bank and subsidy scheme, and
 * the tool produces the DPR a bank or nodal agency asks for against a
 * loan or subsidy application. Paid per report through Razorpay.
 *
 * ── WHICH TABLES ACTUALLY HOLD THE WORK ──────────────────────────────
 *
 * This project exposes 41 tables. An earlier version of this adapter
 * read `dpr_reports`, which looks right by name and is permanently
 * EMPTY — the app never writes to it. Nor does it write to
 * `report_summary`, `report_versions`, `report_comments`, `profiles`,
 * `notifications`, `user_activity_log` or `email_logs`. Reading those
 * made the tool look unused when it is not. Verified live with the
 * service_role key, so the emptiness is real and not RLS.
 *
 * The tables with data in them:
 *
 *   users                   482  accounts (466 are load-test fixtures)
 *   dpr_submissions          98  ** the real record of tool usage **
 *                                id, user_id, dpr_type, business_name,
 *                                full_form_json, created_at, updated_at
 *   payment_orders            2  ** the real money ** Razorpay orders:
 *                                order_id, user_email, business_name,
 *                                dpr_type, plan_category, amount_inr,
 *                                status, payment_id, error_description,
 *                                created_at, paid_at
 *   dpr_projects            254  wizard scaffolding; all 246 owners are
 *                                @vkf.org load-test accounts, all DRAFT
 *   dpr_compiled_documents   47  generated PDFs/DOCX — every one belongs
 *                                to a load-test project
 *   dpr_responses           152  per-question answers, all test accounts
 *   dpr_agent_tasks/results 142  generation pipeline, all test accounts
 *   document_metadata        44  file records, user_id all NULL
 *   dpr_jobs                  5  Aug-2026 runs, user_id all NULL
 *   plus reference data: dpr_sectors(10), dpr_activities(8),
 *   dpr_project_types(6), dpr_blueprints(3), dpr_schemes(1), ...
 *
 * So: one row = one PERSON who used the tool, and `dpr_submissions` is
 * what counts as usage. `dpr_projects` and `dpr_compiled_documents` are
 * deliberately NOT the record list — they hold only load-test rows, and
 * their generated PDFs point at a developer's local disk
 * (C:\Users\dell\Downloads\DPR-main\...), so they are unreachable from
 * anywhere but that machine and cannot be offered for download.
 *
 * ── WHY PEOPLE ARE KEYED BY EMAIL, NOT user_id ───────────────────────
 *
 * Only 5 of 98 submissions carry a usable `user_id`. The other 93 are
 * NULL — the form posts without the session's user. But 77 of those
 * carry the promoter's own email inside `full_form_json.email`, so they
 * ARE attributable; 16 carry nothing at all.
 *
 * Keying on user_id alone would report 5 submissions and hide 93 — it
 * would show the two most recent signups as the only people who ever
 * used the tool. So a person is keyed by email: the account's email when
 * the submission has a user_id, otherwise the contact email typed into
 * the form. Likewise `payment_orders.user_id` is always NULL and its
 * `user_email` is the only link to a buyer.
 *
 * A consequence worth knowing: someone can appear here with no account
 * at all (they filled the form while signed out, or signed up under a
 * different address than they typed). Those rows are marked "No account"
 * rather than quietly merged into a registered user.
 *
 * The 16 submissions with no identity anywhere are counted in the notice
 * returned with the list — never silently dropped, never invented into
 * a person.
 *
 * ── LOAD-TEST FIXTURES ──────────────────────────────────────────────
 *
 * 466 of 482 user rows are @vkf.org or @example.com automated fixtures
 * (388 literally named "User A"/"User B"), all seeded in Aug-2026, and
 * they own all 254 projects and all 47 compiled documents. Left in, they
 * bury the ~16 real signups and make every count meaningless. They are
 * hidden rather than deleted — this panel is read-only — and the number
 * hidden is always reported back, because shrinking a user base from 482
 * to 16 without saying so would be its own kind of lie.
 *
 * Override with DB8_TEST_EMAIL_DOMAINS (comma-separated) or
 * DB8_HIDE_TEST_ACCOUNTS=false.
 *
 * ── OTHER THINGS TO KNOW ────────────────────────────────────────────
 *
 *  - NO FOREIGN KEYS between any of these tables, so PostgREST cannot
 *    embed. Every join is done in JS, one query per table.
 *  - NO SCORE. The panel's record table wants a numeric score, so a
 *    funnel stage is mapped onto it (paid > abandoned > form filled >
 *    signed in > registered). The table never shows that number; it
 *    shows the submission count and the stage.
 *  - `dpr_type` is free text and inconsistent ("Bank Loan DPR",
 *    "Bank Loan DPRs", "Bank Loan DPR (Full Test)", "Investor Pitch DPR"
 *    vs "Investor / Business Pitch DPR"). Displayed verbatim, and only
 *    lightly normalised for grouping.
 *  - Rupee figures inside a submission are the APPLICANT'S OWN project
 *    cost, not revenue. Revenue is only ever payment_orders.amount_inr.
 */

const TABLES = {
  USERS: 'users',
  SUBMISSIONS: 'dpr_submissions',
  ORDERS: 'payment_orders',
  NOTIFICATIONS: 'notifications'
};

const MAX_SCORE = 100;

const USER_SELECT = 'id, name, email, company, phone, service_type, role, created_at, last_login_at';
const SUBMISSION_SELECT = 'id, user_id, dpr_type, business_name, full_form_json, created_at, updated_at';
const ORDER_SELECT = `
  id, order_id, user_id, user_email, user_phone, business_name,
  dpr_type, plan_category, amount_inr, currency, status, payment_id,
  error_code, error_description, created_at, paid_at
`;

/* ──────────────────────────── helpers ──────────────────────────── */

function num(value) {
  const n = Number(value);
  return isNaN(n) ? 0 : n;
}

function blank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** Indian digit grouping, e.g. 1250000 -> ₹12,50,000. */
function formatInr(amount) {
  return '₹' + Math.round(num(amount)).toLocaleString('en-IN');
}

function fmtDate(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function newestFirst(a, b) {
  return new Date(b || 0) - new Date(a || 0);
}

function countBy(rows, keyFn) {
  return (rows || []).reduce((acc, row) => {
    const k = keyFn(row) || 'unknown';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
}

/* ─────────────────────── load-test fixtures ────────────────────── */

const DEFAULT_TEST_DOMAINS = ['vkf.org', 'example.com'];

function testEmailDomains() {
  const raw = process.env.DB8_TEST_EMAIL_DOMAINS;
  if (raw === undefined) return DEFAULT_TEST_DOMAINS;
  return raw.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
}

function hideTestAccounts() {
  return String(process.env.DB8_HIDE_TEST_ACCOUNTS || 'true').toLowerCase() !== 'false';
}

function domainOf(email) {
  const e = normEmail(email);
  const at = e.lastIndexOf('@');
  return at === -1 ? '' : e.slice(at + 1);
}

function isTestEmail(email, domains) {
  const d = domainOf(email);
  return !!d && domains.includes(d);
}

/* ───────────────────────── identity model ──────────────────────── */

/**
 * A candidate id has to survive a round trip through the URL and come
 * back resolvable. Registered people are addressed by their user id;
 * people known only by a form email are addressed by that email,
 * base64url-encoded so a '+' in the address cannot be eaten as a space.
 */
function encodeId(person) {
  if (person.user) return `u_${person.user.id}`;
  return `e_${Buffer.from(person.email, 'utf8').toString('base64url')}`;
}

function decodeId(candidateId) {
  const raw = String(candidateId || '');
  if (raw.startsWith('u_')) return { kind: 'user', userId: raw.slice(2) };
  if (raw.startsWith('e_')) {
    try {
      return { kind: 'email', email: normEmail(Buffer.from(raw.slice(2), 'base64url').toString('utf8')) };
    } catch (e) {
      return { kind: 'email', email: '' };
    }
  }
  // Older links (and the mock ids) are plain user ids.
  return { kind: 'user', userId: raw };
}

/** The email a submission belongs to: the account's, else the form's. */
function submissionEmail(sub, usersById) {
  const u = sub.user_id ? usersById.get(sub.user_id) : null;
  if (u && !blank(u.email)) return normEmail(u.email);
  const form = sub.full_form_json || {};
  return normEmail(form.email || form.contact_email || '');
}

/**
 * Collapses users, submissions and Razorpay orders into one person per
 * email address. Everyone who registered, everyone who submitted, and
 * everyone who paid ends up in here exactly once.
 */
function buildPeople({ users, submissions, orders }) {
  const usersById = new Map();
  (users || []).forEach(u => usersById.set(u.id, u));

  const people = new Map();
  const touch = email => {
    const key = normEmail(email);
    if (!key) return null;
    if (!people.has(key)) {
      people.set(key, { email: key, user: null, subs: [], orders: [] });
    }
    return people.get(key);
  };

  (users || []).forEach(u => {
    const p = touch(u.email);
    if (p) p.user = u;
  });

  let unidentifiedSubs = 0;
  (submissions || []).forEach(sub => {
    const p = touch(submissionEmail(sub, usersById));
    if (!p) { unidentifiedSubs++; return; }
    p.subs.push(sub);
  });

  let unidentifiedOrders = 0;
  (orders || []).forEach(order => {
    const p = touch(order.user_email);
    if (!p) { unidentifiedOrders++; return; }
    p.orders.push(order);
  });

  people.forEach(p => {
    p.subs.sort((a, b) => newestFirst(a.created_at, b.created_at));
    p.orders.sort((a, b) => newestFirst(a.created_at, b.created_at));
  });

  return { people, usersById, unidentifiedSubs, unidentifiedOrders };
}

/** Splits people into the ones worth showing and the test fixtures. */
function partitionPeople(people) {
  const all = [...people.values()];
  if (!hideTestAccounts()) return { real: all, hidden: [] };
  const domains = testEmailDomains();
  const real = [], hidden = [];
  all.forEach(p => (isTestEmail(p.email, domains) ? hidden : real).push(p));
  return { real, hidden };
}

function hiddenNotice(hidden, unidentifiedSubs) {
  const parts = [];
  if (hidden.length) {
    const subs = hidden.reduce((n, p) => n + p.subs.length, 0);
    const domains = testEmailDomains().join(', ');
    // "addresses", not "accounts": a hidden entry can be a form email
    // that never had an account behind it.
    parts.push(
      `${hidden.length} load-test ${hidden.length === 1 ? 'address' : 'addresses'} hidden (${domains})` +
      `${subs ? `, with ${subs} submission${subs === 1 ? '' : 's'} between them` : ''}. ` +
      'Set DB8_HIDE_TEST_ACCOUNTS=false to show them.'
    );
  }
  if (unidentifiedSubs) {
    parts.push(
      `${unidentifiedSubs} submission${unidentifiedSubs === 1 ? '' : 's'} could not be attributed to anyone ` +
      `(no user_id and no email in the form), so ${unidentifiedSubs === 1 ? 'it is' : 'they are'} not listed below.`
    );
  }
  return parts.length ? parts.join(' ') : null;
}

/* ───────────────────── person-level derivations ─────────────────── */

const PAID_STATES = ['paid', 'captured', 'success', 'succeeded', 'completed'];
const ABANDONED_STATES = ['cancelled', 'canceled', 'dismissed', 'abandoned'];

function orderState(order) {
  const s = String(order.status || '').toLowerCase().trim();
  if (PAID_STATES.includes(s) || !blank(order.payment_id)) return 'paid';
  if (ABANDONED_STATES.includes(s)) return 'abandoned';
  if (/fail|error|declin/.test(s)) return 'failed';
  return 'open';
}

function paidOrdersOf(person) {
  return person.orders.filter(o => orderState(o) === 'paid');
}

function revenueOf(person) {
  return paidOrdersOf(person).reduce((n, o) => n + num(o.amount_inr), 0);
}

/**
 * Where this person got to, as one label. Payment outranks everything
 * because it is the only irreversible step; below it, a filled form
 * outranks a bare signup.
 */
function stageOf(person) {
  const paid = paidOrdersOf(person);
  if (paid.length) {
    const amount = revenueOf(person);
    return {
      score: 100,
      label: paid.length === 1 ? `Paid ${formatInr(amount)}` : `Paid ${formatInr(amount)} (${paid.length})`,
      tone: 'high'
    };
  }
  if (person.orders.some(o => orderState(o) === 'abandoned')) {
    return { score: 75, label: 'Checkout abandoned', tone: 'medium' };
  }
  if (person.subs.length) {
    return {
      score: 60,
      label: person.subs.length === 1 ? 'Form filled, unpaid' : `${person.subs.length} forms, unpaid`,
      tone: 'medium'
    };
  }
  if (person.user && person.user.last_login_at) {
    return { score: 30, label: 'Signed in, never filled', tone: 'low' };
  }
  if (person.user) {
    return { score: 10, label: 'Registered, never signed in', tone: 'low' };
  }
  return { score: 0, label: 'No account', tone: 'low' };
}

function displayName(person) {
  if (person.user && !blank(person.user.name)) return String(person.user.name).trim();
  const form = (person.subs[0] && person.subs[0].full_form_json) || {};
  if (!blank(form.contact_name)) return String(form.contact_name).trim();
  if (!blank(form.declarant_name)) return String(form.declarant_name).trim();
  const order = person.orders[0];
  if (order && !blank(order.business_name)) return String(order.business_name).trim();
  return person.email || 'Unknown';
}

function displayCompany(person) {
  if (person.user && !blank(person.user.company)) return String(person.user.company).trim();
  const sub = person.subs[0];
  if (sub && !blank(sub.business_name)) return String(sub.business_name).trim();
  const form = (sub && sub.full_form_json) || {};
  if (!blank(form.business_name)) return String(form.business_name).trim();
  const order = person.orders[0];
  if (order && !blank(order.business_name)) return String(order.business_name).trim();
  return '';
}

function displayPhone(person) {
  if (person.user && !blank(person.user.phone)) return String(person.user.phone).trim();
  const form = (person.subs[0] && person.subs[0].full_form_json) || {};
  if (!blank(form.contact_number)) return String(form.contact_number).trim();
  const withPhone = person.orders.find(o => !blank(o.user_phone));
  if (withPhone) return String(withPhone.user_phone).trim();
  return 'N/A';
}

/** Most recent thing we know this person did. */
function lastActivityOf(person) {
  return [
    person.subs[0] && person.subs[0].created_at,
    person.orders[0] && person.orders[0].created_at,
    person.user && person.user.last_login_at,
    person.user && person.user.created_at
  ].filter(Boolean).sort(newestFirst)[0] || null;
}

/** A light grouping key for the free-text dpr_type values. */
function dprFamily(type) {
  const s = String(type || '').toLowerCase();
  if (/subsid|pmegp|pmfme/.test(s)) return 'Govt Subsidy DPR';
  if (/investor|pitch/.test(s)) return 'Investor / Pitch DPR';
  if (/bank|loan/.test(s)) return 'Bank Loan DPR';
  return blank(type) ? 'Unspecified' : String(type).trim();
}

/* ─────────────────── submission form rendering ─────────────────── */

/**
 * How much of the wizard this person actually completed. The form posts
 * every field whether or not it was touched, so a raw key count says
 * nothing — only the filled ratio does.
 */
function formCompleteness(form) {
  const entries = Object.entries(form || {}).filter(([k]) => k !== 'activeStep');
  if (!entries.length) return { filled: 0, total: 0, pct: 0 };
  const filled = entries.filter(([, v]) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    if (typeof v === 'number') return v !== 0;
    return true;
  }).length;
  return { filled, total: entries.length, pct: Math.round((filled / entries.length) * 100) };
}

function placeOf(form) {
  const parts = [form.village, form.block, form.district, form.state]
    .map(v => (blank(v) ? null : String(v).trim()))
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

/** Costs the applicant entered, omitting the lines they left at zero. */
function costLines(form) {
  return [
    ['Land', form.land_cost],
    ['Building', form.building_cost],
    ['Machinery', form.machinery_cost],
    ['Furniture', form.furniture_cost],
    ['Working capital', form.working_capital],
    ['Raw materials', form.input_cost],
    ['Other', form.other_cost]
  ].filter(([, v]) => num(v) > 0);
}

function fundingLines(form) {
  return [
    ['Promoter contribution', form.promoter_contribution],
    ['Bank loan', form.bank_loan],
    ['Term loan', form.term_loan],
    ['Subsidy claim', form.subsidy],
    ['Margin money claim', form.subsidy_margin_money_claim]
  ].filter(([, v]) => num(v) > 0);
}

/** Only meaningful on an investor-pitch DPR. */
function investorLines(form) {
  return [
    ['Investment ask', form.investment_ask, true],
    ['Equity offered', num(form.equity_offered_percent) ? `${form.equity_offered_percent}%` : null, false],
    ['Pre-money valuation', form.pre_money_valuation, true],
    ['Post-money valuation', form.post_money_valuation, true],
    ['EBITDA multiple target', num(form.ebitda_multiple_target) ? String(form.ebitda_multiple_target) : null, false],
    ['Use of funds', form.use_of_funds, false],
    ['Exit strategy', form.exit_strategy, false],
    ['TAM / SAM / SOM', form.tam_sam_som, false]
  ].filter(([, v, isMoney]) => (isMoney ? num(v) > 0 : !blank(v)));
}

/**
 * One drawer section for one submission: what they are building, where,
 * what it costs and who is funding it.
 */
function submissionSection(sub, title) {
  const form = sub.full_form_json || {};
  const comp = formCompleteness(form);
  const costs = costLines(form);
  const costSum = costs.reduce((n, [, v]) => n + num(v), 0);
  const declared = num(form.total_cost);
  const place = placeOf(form);

  const fields = [
    { label: 'Submitted', value: fmtDate(sub.created_at) },
    { label: 'DPR type', value: sub.dpr_type || form.dpr_type || 'N/A' },
    ...(blank(form.dpr_depth) ? [] : [{ label: 'Depth / plan', value: String(form.dpr_depth) }]),
    {
      label: 'Form completed',
      value: `${comp.pct}% (${comp.filled} of ${comp.total} fields)`,
      tone: comp.pct < 40 ? 'warning' : comp.pct >= 80 ? 'success' : undefined
    },
    ...(form.activeStep === undefined || form.activeStep === null
      ? []
      : [{ label: 'Wizard step reached', value: String(form.activeStep) }]),
    { label: 'Business', value: sub.business_name || form.business_name || 'N/A' },
    ...(blank(form.group_name) ? [] : [{ label: 'Group', value: String(form.group_name) }]),
    ...(blank(form.entity_type) ? [] : [{ label: 'Entity type', value: String(form.entity_type) }]),
    ...(blank(form.business_desc) ? [] : [{ label: 'Description', value: String(form.business_desc) }]),
    ...(blank(form.sector_id) ? [] : [{ label: 'Sector', value: String(form.sector_id) }]),
    ...(blank(form.activity_id) ? [] : [{ label: 'Activity', value: String(form.activity_id) }]),
    ...(blank(form.project_type_id) ? [] : [{ label: 'Project type', value: String(form.project_type_id) }]),
    ...(blank(form.project_scale) ? [] : [{ label: 'Scale', value: String(form.project_scale) }]),
    ...(place ? [{ label: 'Location', value: place }] : []),
    ...(blank(form.geography_id) ? [] : [{ label: 'Geography code', value: String(form.geography_id), mono: true }]),
    ...(blank(form.primary_product) ? [] : [{ label: 'Primary product', value: String(form.primary_product) }])
  ];

  // Registration ids the promoter supplied — the quickest way to tell a
  // real applicant from a test one.
  [['CIN', form.cin], ['GST', form.gst_no], ['PAN', form.pan_no], ['Udyam', form.udyam_no], ['FSSAI', form.fssai_no]]
    .filter(([, v]) => !blank(v))
    .forEach(([label, v]) => fields.push({ label, value: String(v), mono: true }));

  if (costs.length || declared > 0) {
    fields.push({
      label: 'Total project cost',
      value: formatInr(declared > 0 ? declared : costSum),
      tone: 'success'
    });
    costs.forEach(([label, v]) => fields.push({ label: `  ${label}`, value: formatInr(v) }));
    // A declared total that disagrees with its own line items is worth
    // showing rather than silently preferring one of the two.
    if (declared > 0 && costSum > 0 && Math.abs(declared - costSum) > 1) {
      fields.push({
        label: '  Line items sum to',
        value: `${formatInr(costSum)} — does not match the declared total`,
        tone: 'warning'
      });
    }
  }

  fundingLines(form).forEach(([label, v]) => fields.push({ label, value: formatInr(v) }));

  [['Lending bank', form.primary_lending_bank || form.bank_name],
    ['Branch', form.bank_branch],
    ['IFSC', form.ifsc],
    ['Collateral', form.collateral_offered],
    ['Loan scheme', form.bank_loan_scheme_name],
    ['Govt scheme', form.govt_scheme_name],
    ['Nodal agency', form.nodal_agency],
    ['Subsidy category', form.location_subsidy_category],
    ['Social category', form.social_category],
    ['EDP training', form.edp_training_status]]
    .filter(([, v]) => !blank(v))
    .forEach(([label, v]) => fields.push({ label, value: String(v) }));

  [['Interest rate', num(form.interest_rate_percent) ? `${form.interest_rate_percent}%` : null],
    ['Repayment tenure', num(form.repayment_tenure_years) ? `${form.repayment_tenure_years} years` : null],
    ['Moratorium', num(form.moratorium_period_months) ? `${form.moratorium_period_months} months` : null],
    ['CIBIL score', blank(form.cibil_score) ? null : String(form.cibil_score)]]
    .filter(([, v]) => v)
    .forEach(([label, v]) => fields.push({ label, value: v }));

  investorLines(form).forEach(([label, v, isMoney]) =>
    fields.push({ label, value: isMoney ? formatInr(v) : String(v) }));

  if (Array.isArray(form.machinery) && form.machinery.length) {
    fields.push({ label: 'Machinery items', value: String(form.machinery.length) });
  }
  if (Array.isArray(form.members) && form.members.length) {
    fields.push({ label: 'Team members listed', value: String(form.members.length) });
  }

  // Contact details as typed into the form, which is how the 93
  // user_id-less submissions were attributed in the first place.
  if (!blank(form.contact_name)) fields.push({ label: 'Contact name', value: String(form.contact_name) });
  if (!blank(form.contact_number)) fields.push({ label: 'Contact number', value: String(form.contact_number) });
  if (!blank(form.email)) fields.push({ label: 'Contact email', value: String(form.email) });
  if (!blank(form.associated_with_vkf)) fields.push({ label: 'Associated with VKF', value: String(form.associated_with_vkf) });

  fields.push({ label: 'Submission ID', value: String(sub.id), mono: true });
  fields.push({
    label: 'Linked to account',
    value: sub.user_id ? 'Yes' : 'No — matched by the email typed into the form',
    tone: sub.user_id ? undefined : 'warning'
  });

  return { title, fields };
}

/* ──────────────────────────── adapter ──────────────────────────── */

async function loadCore(supabase) {
  const [usersRes, subsRes, ordersRes] = await Promise.all([
    supabase.from(TABLES.USERS).select(USER_SELECT),
    supabase.from(TABLES.SUBMISSIONS).select(SUBMISSION_SELECT).order('created_at', { ascending: false }),
    supabase.from(TABLES.ORDERS).select(ORDER_SELECT).order('created_at', { ascending: false })
  ]);

  if (usersRes.error) throw usersRes.error;

  // Submissions and orders are each secondary to listing people at all:
  // if one is unreadable, say so loudly and carry on rather than
  // collapsing the whole view into mock data.
  if (subsRes.error) {
    console.warn(`[db8] ${TABLES.SUBMISSIONS} unreadable, usage counts will read 0: ${subsRes.error.message}`);
  }
  if (ordersRes.error) {
    console.warn(`[db8] ${TABLES.ORDERS} unreadable, payments will be omitted: ${ordersRes.error.message}`);
  }

  return {
    users: usersRes.data || [],
    submissions: subsRes.error ? [] : (subsRes.data || []),
    orders: ordersRes.error ? [] : (ordersRes.data || []),
    submissionsReadable: !subsRes.error,
    ordersReadable: !ordersRes.error
  };
}

/**
 * One row per person who registered, filled the form, or paid — newest
 * activity first. See the header for why people are keyed by email.
 */
async function getCandidates(supabase) {
  const core = await loadCore(supabase);
  const { people, unidentifiedSubs } = buildPeople(core);
  const { real, hidden } = partitionPeople(people);

  const candidates = real
    .map(person => {
      const stage = stageOf(person);
      const name = displayName(person);
      const company = displayCompany(person);
      return {
        id: encodeId(person),
        name: company && company !== name ? `${name} (${company})` : name,
        email: person.email || 'No Email',
        phone: displayPhone(person),
        // The table's date column. Last activity is far more useful here
        // than a signup date, since 7 of these people have no signup.
        testDate: lastActivityOf(person),
        score: stage.score,
        maxScore: MAX_SCORE,

        // --- db8-specific row display ---
        scoreLabel: person.subs.length ? String(person.subs.length) : '—',
        statusLabel: stage.label,
        statusTone: stage.tone
      };
    })
    .sort((a, b) => newestFirst(a.testDate, b.testDate));

  return { candidates, notice: hiddenNotice(hidden, unidentifiedSubs) };
}

/**
 * One person's full record: their account (if any), how far they got,
 * what they paid, and every DPR form they filled, in full.
 */
async function getCandidateDetails(supabase, candidateId) {
  const ref = decodeId(candidateId);

  // Resolve the person to an email first — everything else keys off it.
  let user = null;
  let email = ref.email || '';

  if (ref.kind === 'user') {
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select(USER_SELECT)
      .eq('id', ref.userId)
      .single();
    if (error) throw error;
    user = data;
    email = normEmail(user.email);
  } else {
    if (!email) throw new Error(`Could not decode candidate id "${candidateId}".`);
    const { data } = await supabase
      .from(TABLES.USERS)
      .select(USER_SELECT)
      .eq('email', email)
      .limit(1);
    user = (data && data[0]) || null;
  }

  const tryRows = async build => {
    try {
      const { data, error } = await build();
      return error ? [] : (data || []);
    } catch (e) {
      return [];
    }
  };

  // Two queries rather than one `or`, because the email lives inside a
  // JSON column and quoting it into an or-filter is a footgun.
  const [byAccount, byFormEmail, orders, notifications] = await Promise.all([
    user
      ? tryRows(() => supabase.from(TABLES.SUBMISSIONS).select(SUBMISSION_SELECT).eq('user_id', user.id))
      : Promise.resolve([]),
    email
      ? tryRows(() => supabase.from(TABLES.SUBMISSIONS).select(SUBMISSION_SELECT).eq('full_form_json->>email', email))
      : Promise.resolve([]),
    email
      ? tryRows(() => supabase.from(TABLES.ORDERS).select(ORDER_SELECT).eq('user_email', email))
      : Promise.resolve([]),
    user
      ? tryRows(() => supabase.from(TABLES.NOTIFICATIONS)
        .select('id, title, message, type, is_read, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5))
      : Promise.resolve([])
  ]);

  const seen = new Set();
  const subs = byAccount.concat(byFormEmail)
    .filter(s => (seen.has(s.id) ? false : seen.add(s.id)))
    .sort((a, b) => newestFirst(a.created_at, b.created_at));

  const person = {
    email,
    user,
    subs,
    orders: orders.sort((a, b) => newestFirst(a.created_at, b.created_at))
  };
  const stage = stageOf(person);
  const company = displayCompany(person);
  const revenue = revenueOf(person);

  const sections = [];

  sections.push({
    title: 'Person',
    fields: [
      { label: 'Name', value: displayName(person) },
      { label: 'Email', value: email || 'N/A' },
      { label: 'Phone', value: displayPhone(person) },
      { label: 'Company', value: company || 'N/A' },
      user
        ? { label: 'Account', value: `Registered ${fmtDate(user.created_at)}` }
        : {
          label: 'Account',
          value: 'No account under this address — they filled the form while signed out, or signed up under a different email.',
          tone: 'warning'
        },
      ...(user ? [
        {
          label: 'Last login',
          value: user.last_login_at ? fmtDate(user.last_login_at) : 'Never signed in',
          tone: user.last_login_at ? undefined : 'warning'
        },
        { label: 'Service', value: user.service_type || 'N/A' },
        { label: 'Role', value: user.role || 'N/A' },
        { label: 'User ID', value: String(user.id), mono: true }
      ] : [])
    ]
  });

  const families = [...new Set(subs.map(s => dprFamily(s.dpr_type)))];
  sections.push({
    title: 'Activity',
    fields: [
      {
        label: 'Stage',
        value: stage.label,
        tone: stage.tone === 'high' ? 'success' : stage.tone === 'low' ? 'warning' : undefined
      },
      { label: 'DPR forms filled', value: String(subs.length) },
      ...(subs.length ? [
        { label: 'First filled', value: fmtDate(subs[subs.length - 1].created_at) },
        { label: 'Last filled', value: fmtDate(subs[0].created_at) },
        { label: 'DPR types used', value: families.join(', ') }
      ] : [{ label: 'Forms', value: 'This person has never submitted the DPR form.', tone: 'warning' }])
    ]
  });

  sections.push({
    title: 'Payment',
    fields: person.orders.length
      ? [
        {
          label: 'Paid',
          value: revenue > 0 ? formatInr(revenue) : 'Nothing captured',
          tone: revenue > 0 ? 'success' : 'warning'
        },
        { label: 'Orders opened', value: String(person.orders.length) },
        ...person.orders.map(o => {
          const st = orderState(o);
          return {
            label: fmtDate(o.created_at).slice(0, 10),
            value: `${formatInr(o.amount_inr)} · ${o.dpr_type || 'DPR'}` +
              `${blank(o.plan_category) ? '' : ` (${o.plan_category} plan)`}` +
              `\n${st === 'paid'
                ? `Paid ${fmtDate(o.paid_at || o.created_at)} · ${o.payment_id}`
                : `${o.status}${blank(o.error_description) ? '' : ` — ${o.error_description}`}`}` +
              `\nOrder ${o.order_id}`,
            tone: st === 'paid' ? 'success' : st === 'abandoned' ? 'warning' : undefined
          };
        })
      ]
      : [{ label: 'Status', value: 'No Razorpay order was ever opened for this address.' }]
  });

  if (subs.length) {
    // Newest first, and capped — one person here has 60 runs, and
    // rendering all of them would bury everything above.
    const SHOWN = 8;
    subs.slice(0, SHOWN).forEach((sub, i) => {
      const n = subs.length - i;
      const title = subs.length === 1
        ? `DPR form: ${sub.business_name || 'Untitled'}`
        : `DPR form ${n} of ${subs.length}: ${sub.business_name || 'Untitled'}`;
      sections.push(submissionSection(sub, title));
    });
    if (subs.length > SHOWN) {
      const extra = subs.length - SHOWN;
      sections.push({
        title: 'Earlier submissions',
        fields: [{
          label: 'Not shown',
          value: `${extra} earlier submission${extra === 1 ? '' : 's'}, from ` +
            `${fmtDate(subs[subs.length - 1].created_at).slice(0, 10)} to ` +
            `${fmtDate(subs[SHOWN].created_at).slice(0, 10)}. ` +
            `Only the ${SHOWN} most recent are rendered.`
        }]
      });
    }
  }

  if (notifications.length) {
    sections.push({
      title: 'Notifications',
      fields: notifications.map(n => ({
        label: fmtDate(n.created_at).slice(0, 10),
        value: `${n.title || n.type || 'Notification'}${n.message ? `\n${n.message}` : ''}`,
        tone: n.is_read === false ? 'warning' : undefined
      }))
    });
  }

  return {
    personalInfo: {
      id: String(candidateId),
      name: displayName(person),
      email: email || 'No Email',
      testDate: lastActivityOf(person),
      score: stage.score,
      maxScore: MAX_SCORE,
      sessionId: user ? String(user.id) : email,
      screenshotUrl: null
    },
    sections,
    // The panel's legacy Q&A shape, derived from the sections above so
    // the two can never drift apart.
    results: sections.map(sec => ({
      question: sec.title,
      answer: sec.fields.map(f => `${f.label}: ${f.value}`).join('\n'),
      score: null,
      maxScore: null
    }))
  };
}

/**
 * Razorpay revenue. Unlike most tools in this panel, this one really
 * does take money — payment_orders holds one row per checkout attempt,
 * with the rupee amount and whether it was captured.
 */
async function getPaymentSummary(supabase) {
  const core = await loadCore(supabase);
  const { people } = buildPeople(core);
  const { real } = partitionPeople(people);

  const domains = testEmailDomains();
  const orders = hideTestAccounts()
    ? core.orders.filter(o => !isTestEmail(o.user_email, domains))
    : core.orders;

  const paidOrders = orders.filter(o => orderState(o) === 'paid');
  const lostOrders = orders.filter(o => ['abandoned', 'open', 'failed'].includes(orderState(o)));

  const totalRevenue = paidOrders.reduce((n, o) => n + num(o.amount_inr), 0);
  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const revenue30d = paidOrders.reduce((n, o) => {
    const t = new Date(o.paid_at || o.created_at).getTime();
    return !isNaN(t) && t >= cutoff30d ? n + num(o.amount_inr) : n;
  }, 0);

  const payers = new Set(paidOrders.map(o => normEmail(o.user_email)).filter(Boolean));
  const reachedCheckout = new Set(orders.map(o => normEmail(o.user_email)).filter(Boolean));

  // The denominator is everyone the tool has reached, not just
  // registered accounts — several of these people never made one.
  const totalPeople = real.length;
  const paidCount = payers.size;
  const unpaidCount = Math.max(0, totalPeople - paidCount);
  const total = Math.max(totalPeople, paidCount);
  const submitters = real.filter(p => p.subs.length).length;

  // What the non-payers are. This is the only unpaid breakdown that
  // means anything here, since there are no subscription statuses.
  //
  // The buckets are assigned by first match, so they are mutually
  // exclusive and sum to unpaidCount. Overlapping buckets would add up
  // to more than the number of unpaid people and read as nonsense.
  const unpaidCounts = {
    'abandoned at checkout': 0,
    'filled the form, never reached checkout': 0,
    'registered, never filled the form': 0,
    'reached the tool but did neither': 0
  };
  real.filter(p => !payers.has(p.email)).forEach(p => {
    if (p.orders.length) unpaidCounts['abandoned at checkout']++;
    else if (p.subs.length) unpaidCounts['filled the form, never reached checkout']++;
    else if (p.user) unpaidCounts['registered, never filled the form']++;
    else unpaidCounts['reached the tool but did neither']++;
  });
  const unpaidBreakdown = Object.entries(unpaidCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);

  return {
    // --- panel-wide payment contract ---
    hasRevenueAmount: core.ordersReadable,
    totalRevenue,
    paidCount,
    unpaidCount,
    paymentRate: total > 0 ? Math.round((paidCount / total) * 100) : 0,
    unpaidBreakdown,

    // --- db8-specific billing detail ---
    billing: {
      provider: 'Razorpay',
      model: 'one-off per-report',
      // There is no subscriptions table in this project, so the panel's
      // subscriber KPI row is suppressed rather than shown as zeroes.
      subscriptionsAvailable: false,
      subscriptionRows: null,
      revenueAvailable: core.ordersReadable,
      revenueNote: core.ordersReadable
        ? 'Revenue is the sum of payment_orders.amount_inr for captured orders. The rupee figures inside a DPR submission are the applicant\'s own project cost, not revenue, and are never counted here.'
        : 'The payment_orders table could not be read with this key, so revenue is unavailable.',

      razorpayPayments: paidOrders.length,
      razorpayPayers: paidCount,
      totalRevenueInr: totalRevenue,
      revenueLast30dInr: revenue30d,
      averagePaymentInr: paidOrders.length ? Math.round(totalRevenue / paidOrders.length) : 0,
      totalUsers: totalPeople,

      // --- checkout funnel ---
      // An order that was never captured is a named person who reached
      // the payment page and left. That is the most actionable number on
      // this page, so it is reported even when it is small.
      checkoutFunnelAvailable: core.ordersReadable,
      ordersCreated: orders.length,
      ordersPaid: paidOrders.length,
      ordersAbandoned: lostOrders.length,
      abandonedValueInr: lostOrders.reduce((n, o) => n + num(o.amount_inr), 0),
      checkoutConversionRate: orders.length ? Math.round((paidOrders.length / orders.length) * 100) : 0,
      // Reuses the panel's existing "abandoned by type" line. For this
      // tool the type is the DPR product, not a deck type.
      abandonedByDeckType: Object.entries(countBy(lostOrders, o => o.dpr_type))
        .map(([deckType, count]) => ({ deckType, count }))
        .sort((a, b) => b.count - a.count),

      // --- the funnel above checkout, which is where the loss is ---
      peopleReached: totalPeople,
      formsSubmitted: core.submissions.length,
      peopleWhoSubmitted: submitters,
      checkoutReach: reachedCheckout.size,
      submitToCheckoutRate: submitters ? Math.round((reachedCheckout.size / submitters) * 100) : 0,

      planBreakdown: Object.entries(countBy(orders, o => o.plan_category || 'unspecified'))
        .map(([plan, count]) => ({
          plan,
          count,
          payingCount: paidOrders.filter(o => (o.plan_category || 'unspecified') === plan).length
        }))
        .sort((a, b) => b.count - a.count),
      statusBreakdown: Object.entries(countBy(orders, o => String(o.status || '').toLowerCase().trim()))
        .map(([status, count]) => ({ status: status || 'unknown', count }))
        .sort((a, b) => b.count - a.count)
    }
  };
}

async function getUserBreakdown(supabase) {
  const core = await loadCore(supabase);
  const { people } = buildPeople(core);
  const { real } = partitionPeople(people);

  const users = real.map(person => ({
    userId: encodeId(person),
    name: displayName(person),
    // "attempts" in the panel's contract — here, DPR forms submitted.
    attempts: person.subs.length,
    averageScore: stageOf(person).score,
    lastActivity: lastActivityOf(person)
  }));

  const totalSubs = users.reduce((s, u) => s + u.attempts, 0);

  return {
    totalUniqueUsers: users.length,
    averageAttemptsPerUser: users.length > 0
      ? Math.round((totalSubs / users.length) * 10) / 10
      : 0,
    users: users.sort((a, b) =>
      b.attempts - a.attempts ||
      newestFirst(a.lastActivity, b.lastActivity))
  };
}

/**
 * Grouped by company — the one a user typed at signup, falling back to
 * the business name on their most recent DPR, which is the only thing a
 * person with no account has. The blank bucket is labelled honestly
 * rather than dropped.
 */
async function getOrgBreakdown(supabase) {
  const core = await loadCore(supabase);
  const { people } = buildPeople(core);
  const { real } = partitionPeople(people);

  const orgMap = {};
  real.forEach(person => {
    const key = displayCompany(person) || 'Not provided';
    const row = orgMap[key] || (orgMap[key] = { people: 0, subs: 0, revenue: 0, stages: [], last: null });
    row.people++;
    row.subs += person.subs.length;
    row.revenue += revenueOf(person);
    row.stages.push(stageOf(person).score);
    const last = lastActivityOf(person);
    if (last && (!row.last || new Date(last) > new Date(row.last))) row.last = last;
  });

  return Object.entries(orgMap)
    .map(([organization, row]) => ({
      organization,
      // The panel's contract: this is the volume column. Here it is the
      // number of people from that company.
      totalAssessments: row.people,
      averageScore: row.stages.length
        ? Math.round(row.stages.reduce((a, b) => a + b, 0) / row.stages.length)
        : 0,
      // db8 extras.
      submissions: row.subs,
      revenueInr: row.revenue,
      lastActivity: row.last
    }))
    .sort((a, b) => b.submissions - a.submissions || b.totalAssessments - a.totalAssessments);
}

/**
 * Repeat usage: having filled the form once, did they come back and fill
 * it again within 1 / 7 / 30 days? Cohorted on the person, not the
 * account, so the 93 submissions with no user_id still count.
 */
async function getRetentionCohort(supabase) {
  const core = await loadCore(supabase);
  const { people } = buildPeople(core);
  const { real } = partitionPeople(people);

  const rows = [];
  real.forEach(person => {
    person.subs.forEach(sub => {
      rows.push({ person: person.email, created_at: sub.created_at });
    });
  });

  return buildRetentionCohort(rows, 'person', 'created_at');
}

/*
 * NOT EXPORTED, deliberately:
 *   getDimensionAverages — there are no sub-scores to average. The DPR
 *                          form has no marks; its numbers are the
 *                          applicant's project costs.
 */

function getMockCandidates() {
  return [
    { id: 'u_db8-user-1', name: 'Ramesh Kumar (Sree Agro Foods)', email: 'ramesh@sreeagro.in', phone: '+91 98450 11223', testDate: '2026-11-15T10:10:00Z', score: 100, maxScore: 100, scoreLabel: '2', statusLabel: 'Paid ₹799', statusTone: 'high' },
    { id: 'u_db8-user-2', name: 'Lakshmi Devi (Devi Handlooms)', email: 'lakshmi@devihandlooms.in', phone: '+91 90000 44556', testDate: '2026-11-13T08:40:00Z', score: 75, maxScore: 100, scoreLabel: '1', statusLabel: 'Checkout abandoned', statusTone: 'medium' },
    { id: 'e_aW1yYW5Ac2hhaWtoZGFpcnkuaW4', name: 'Imran Shaikh (Shaikh Dairy)', email: 'imran@shaikhdairy.in', phone: '+91 98111 22334', testDate: '2026-11-11T12:20:00Z', score: 60, maxScore: 100, scoreLabel: '3', statusLabel: '3 forms, unpaid', statusTone: 'medium' },
    { id: 'u_db8-user-4', name: 'Anita Rao', email: 'anita@raofoods.in', phone: 'N/A', testDate: '2026-11-10T15:05:00Z', score: 30, maxScore: 100, scoreLabel: '—', statusLabel: 'Signed in, never filled', statusTone: 'low' }
  ];
}

function getMockCandidateDetails(candidateId) {
  const candidates = getMockCandidates();
  const personalInfo = candidates.find(c => c.id === candidateId) || candidates[0];

  const sections = [
    {
      title: 'Person',
      fields: [
        { label: 'Name', value: 'Ramesh Kumar' },
        { label: 'Email', value: 'ramesh@sreeagro.in' },
        { label: 'Phone', value: '+91 98450 11223' },
        { label: 'Company', value: 'Sree Agro Foods' },
        { label: 'Account', value: 'Registered 2026-10-30 07:12 UTC' },
        { label: 'Last login', value: '2026-11-15 10:02 UTC' },
        { label: 'Service', value: 'Bank Loan DPR' },
        { label: 'Role', value: 'PROMOTER' },
        { label: 'User ID', value: 'db8-user-1', mono: true }
      ]
    },
    {
      title: 'Activity',
      fields: [
        { label: 'Stage', value: 'Paid ₹799', tone: 'success' },
        { label: 'DPR forms filled', value: '2' },
        { label: 'First filled', value: '2026-11-02 09:15 UTC' },
        { label: 'Last filled', value: '2026-11-15 10:10 UTC' },
        { label: 'DPR types used', value: 'Bank Loan DPR' }
      ]
    },
    {
      title: 'Payment',
      fields: [
        { label: 'Paid', value: '₹799', tone: 'success' },
        { label: 'Orders opened', value: '1' },
        { label: '2026-11-15', value: '₹799 · Bank Loan DPR (core plan)\nPaid 2026-11-15 10:11 UTC · pay_MOCK123456\nOrder order_MOCK123456', tone: 'success' }
      ]
    },
    {
      title: 'DPR form 2 of 2: Sree Agro Foods',
      fields: [
        { label: 'Submitted', value: '2026-11-15 10:10 UTC' },
        { label: 'DPR type', value: 'Bank Loan DPR' },
        { label: 'Depth / plan', value: 'core' },
        { label: 'Form completed', value: '91% (124 of 136 fields)', tone: 'success' },
        { label: 'Wizard step reached', value: '8' },
        { label: 'Business', value: 'Sree Agro Foods' },
        { label: 'Entity type', value: 'Proprietorship' },
        { label: 'Sector', value: 'food_processing' },
        { label: 'Scale', value: 'medium' },
        { label: 'Location', value: 'Hubballi, Dharwad, Karnataka' },
        { label: 'Udyam', value: 'UDYAM-KA-07-0012345', mono: true },
        { label: 'Total project cost', value: '₹24,50,000', tone: 'success' },
        { label: '  Building', value: '₹6,00,000' },
        { label: '  Machinery', value: '₹12,00,000' },
        { label: '  Working capital', value: '₹4,50,000' },
        { label: '  Raw materials', value: '₹1,50,000' },
        { label: '  Other', value: '₹50,000' },
        { label: 'Promoter contribution', value: '₹2,45,000' },
        { label: 'Bank loan', value: '₹17,15,000' },
        { label: 'Subsidy claim', value: '₹4,90,000' },
        { label: 'Lending bank', value: 'Canara Bank' },
        { label: 'Loan scheme', value: 'Commercial Term Loan / Cash Credit' },
        { label: 'Interest rate', value: '10.5%' },
        { label: 'Repayment tenure', value: '5 years' },
        { label: 'Submission ID', value: 'db8-sub-2', mono: true },
        { label: 'Linked to account', value: 'Yes' }
      ]
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

function getMockPaymentSummary() {
  return {
    hasRevenueAmount: true,
    totalRevenue: 1198,
    paidCount: 2,
    unpaidCount: 14,
    paymentRate: 13,
    unpaidBreakdown: [
      { status: 'filled the form, never paid', count: 8 },
      { status: 'registered, never filled the form', count: 5 },
      { status: 'abandoned at checkout', count: 1 }
    ],
    billing: {
      provider: 'Razorpay',
      model: 'one-off per-report',
      subscriptionsAvailable: false,
      subscriptionRows: null,
      revenueAvailable: true,
      revenueNote: 'Mock data.',
      razorpayPayments: 2,
      razorpayPayers: 2,
      totalRevenueInr: 1198,
      revenueLast30dInr: 799,
      averagePaymentInr: 599,
      totalUsers: 16,
      checkoutFunnelAvailable: true,
      ordersCreated: 3,
      ordersPaid: 2,
      ordersAbandoned: 1,
      abandonedValueInr: 799,
      checkoutConversionRate: 67,
      abandonedByDeckType: [{ deckType: 'Bank Loan DPR', count: 1 }],
      peopleReached: 16,
      formsSubmitted: 21,
      peopleWhoSubmitted: 10,
      checkoutReach: 3,
      submitToCheckoutRate: 30,
      planBreakdown: [
        { plan: 'core', count: 2, payingCount: 1 },
        { plan: 'entry', count: 1, payingCount: 1 }
      ],
      statusBreakdown: [
        { status: 'paid', count: 2 },
        { status: 'cancelled', count: 1 }
      ]
    }
  };
}

module.exports = {
  getCandidates,
  getCandidateDetails,
  getMockCandidates,
  getMockCandidateDetails,
  getPaymentSummary,
  getMockPaymentSummary,
  getUserBreakdown,
  getOrgBreakdown,
  getRetentionCohort,
  metadata: {
    name: 'DPR Generator',
    category: 'Product',
    // Confirmed by the account owner. Drives the uptime check in
    // GET /api/health.
    siteUrl: 'https://dpr.infopaceindia.com',
    description: 'Detailed Project Report builder for bank loan and government subsidy applications — who filled the DPR form, what they are building, and what they paid through Razorpay.',
    candidateColumns: {
      name: 'Promoter & Business',
      score: 'DPRs Filled',
      status: 'Status',
      // There is no transcript to export for a DPR record, and the
      // generated PDFs live on a developer's local disk.
      showPdf: false,
      subtitle: 'Everyone who filled the DPR form or registered — how many reports each started, and what they paid.'
    },
    detailView: {
      title: 'Promoter & DPR Details',
      loadingText: 'Fetching promoter record...',
      dateLabel: 'Last activity',
      showScore: false,
      showPdf: false
    }
  }
};
