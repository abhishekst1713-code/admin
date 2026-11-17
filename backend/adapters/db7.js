const { buildRetentionCohort } = require('./_retention');

/**
 * DB7 Adapter: Pitch Deck Builder
 *
 * SCHEMA (discovered live against the project with the anon key, since
 * neither the PostgREST OpenAPI root nor pg_graphql is reachable with an
 * anon key on this project — see the unverified notes below):
 *
 *   users          id, created_at, updated_at, name, email, role,
 *                  stripe_customer_id, avatar_url, is_active
 *   projects       id, user_id -> users.id, created_at, updated_at,
 *                  deleted_at, is_deleted, name, status, error_message
 *   jobs           id, project_id -> projects.id, created_at, started_at,
 *                  completed_at, status, result, error
 *   subscriptions  id, user_id -> users.id, created_at, updated_at,
 *                  status, plan, stripe_subscription_id,
 *                  current_period_start, current_period_end
 *   payments       id, user_id -> users.id, created_at, amount_inr,
 *                  razorpay_payment_id, razorpay_order_id
 *   presentations  id, user_id -> users.id, project_id -> projects.id,
 *                  created_at, updated_at, status, slide_count,
 *                  file_url, thumbnail_url
 *
 * TWO PAYMENT MECHANISMS COEXIST IN THIS PROJECT:
 *   - payments      Razorpay, one row per captured payment, with a real
 *                   rupee amount (amount_inr). This is the one that can
 *                   report revenue.
 *   - subscriptions Stripe-shaped (stripe_subscription_id, period
 *                   window, plan) with no amount column at all.
 * Both are read below. Which one the live app actually writes could not
 * be confirmed - every table in this project returns 0 rows to an anon
 * key - so neither is assumed dead and the summary reports both.
 *
 * HOW THIS DIFFERS FROM db1-db6, and what that costs:
 *
 * Every other tool in this panel is an assessment: one row per attempt,
 * with a real score column. This project is not — it is a deck-building
 * SaaS (user -> project -> generation job, billed by subscription), and
 * there is NO score column anywhere in it. The panel's candidate contract
 * requires a numeric score/maxScore (the table in App.jsx renders
 * c.score / c.maxScore and a percentage badge with no null guard), so
 * this adapter reports a GENERATION-PROGRESS figure instead:
 *
 *   completed -> 100, in progress -> 50, draft -> 25, failed -> 0
 *
 * That is a pipeline-progress figure, NOT an assessment result and not a
 * quality judgement of anyone's deck. It is labelled that way in the
 * detail view. If this tool should not sit in the same score-badged
 * table at all, that is a UI change (a non-scored branch of the db view),
 * not an adapter one.
 *
 * TWO THINGS COULD NOT BE VERIFIED LIVE:
 *  1. All four tables return 0 rows to the anon key. That is either a
 *     genuinely empty project or RLS policies scoped to the signed-in
 *     user, which an anon key can never satisfy; PostgREST answers both
 *     cases with an empty 200, so they are indistinguishable from here.
 *     If the panel shows this tool as live-but-empty while the app has
 *     data, swap SUPABASE_KEY_7 for the project's service_role key (as
 *     SUPABASE_KEY_SOCIAL already does).
 *  2. status/plan/role are plain text columns, not enums, and there were
 *     no rows to sample, so the exact strings the app writes are unknown.
 *     Every status read below is therefore matched case-insensitively
 *     against families of likely values and falls through to a safe
 *     default, rather than compared against one guessed literal.
 */

const TABLES = {
  USERS: 'users',
  PROJECTS: 'projects',
  JOBS: 'jobs',
  SUBSCRIPTIONS: 'subscriptions',
  PAYMENTS: 'payments',
  PRESENTATIONS: 'presentations',
  // The Razorpay checkout funnel: one row per order created, whose
  // status becomes 'consumed' once the payment is captured and the
  // credit is spent on a project. Rows left at 'created' are abandoned
  // checkouts — people who reached the payment page and did not pay.
  DECK_CREDITS: 'deck_credits'
};

const MAX_SCORE = 100;

// A project row plus its owner, embedded over the
// projects.user_id -> users.id foreign key (verified live).
const PROJECT_SELECT = `
  id, user_id, name, status, error_message, created_at, updated_at,
  deleted_at, is_deleted,
  users ( id, name, email, role, is_active, stripe_customer_id )
`;

/**
 * Status -> progress bucket. Case-insensitive family matching, because
 * the real status strings could not be sampled (see the header note).
 * Returns null for an unrecognized value so callers can say "unknown"
 * instead of silently reporting it as a failure.
 */
function statusBucket(status) {
  const s = String(status || '').toLowerCase().trim();
  if (!s) return null;
  if (/(completed|complete|ready|done|success|succeeded|generated|finished|published)/.test(s)) return 'completed';
  if (/(processing|generating|running|in_progress|inprogress|pending|queued|started|working)/.test(s)) return 'in_progress';
  if (/(draft|created|new|initialised|initialized|unstarted)/.test(s)) return 'draft';
  if (/(failed|failure|error|cancelled|canceled|aborted|timeout|rejected)/.test(s)) return 'failed';
  return null;
}

const BUCKET_SCORE = { completed: 100, in_progress: 50, draft: 25, failed: 0 };
const BUCKET_LABEL = {
  completed: 'Completed',
  in_progress: 'In progress',
  draft: 'Draft',
  failed: 'Failed'
};

function progressScore(status) {
  const bucket = statusBucket(status);
  if (!bucket) return 0;
  return BUCKET_SCORE[bucket];
}

function progressLabel(status) {
  const bucket = statusBucket(status);
  if (!bucket) return status ? `Unrecognized status ("${status}")` : 'No status set';
  return BUCKET_LABEL[bucket];
}

/**
 * Payment state for ONE user, as a row badge.
 *
 * This is the structural difference from db1-db5. In those tools the
 * payment lives on the same row as the attempt (a `paid` boolean or a
 * `payment_status` string), so "who took it" and "did they pay" are one
 * read. Here billing is a separate per-user Stripe subscription, so the
 * owner's subscription has to be joined onto each deck row to answer the
 * same question.
 *
 * `tone` maps onto the panel's existing score-badge classes
 * (high/medium/low) so no new CSS is needed.
 */
/** Sum of captured Razorpay payments per user, in whole rupees. */
function paymentTotalsByUser(payments) {
  const byUser = new Map();
  (payments || []).forEach(row => {
    if (!row.user_id) return;
    const amount = Number(row.amount_inr) || 0;
    const prev = byUser.get(row.user_id) || { total: 0, count: 0, last: null };
    prev.total += amount;
    prev.count += 1;
    if (!prev.last || new Date(row.created_at) > new Date(prev.last)) prev.last = row.created_at;
    byUser.set(row.user_id, prev);
  });
  return byUser;
}

function formatInr(amount) {
  return '₹' + Math.round(Number(amount) || 0).toLocaleString('en-IN');
}

function paymentBadge(sub) {
  if (!sub) {
    return { label: 'Free', tone: 'low', status: 'none', plan: null, periodEnd: null };
  }
  const raw = String(sub.status || '').toLowerCase().trim();
  const plan = sub.plan || null;
  const base = { status: raw || 'unknown', plan, periodEnd: sub.current_period_end || null };

  if (raw === 'past_due') return { ...base, label: 'Past due', tone: 'medium' };
  if (isPayingStatus(raw)) return { ...base, label: plan ? `Paying — ${plan}` : 'Paying', tone: 'high' };
  if (isTrialStatus(raw)) return { ...base, label: plan ? `Trial — ${plan}` : 'Trial', tone: 'medium' };
  if (isCanceledStatus(raw)) return { ...base, label: 'Canceled', tone: 'low' };
  return { ...base, label: raw ? `Subscription: ${raw}` : 'Free', tone: 'low' };
}

/**
 * user_id -> the subscription that best describes that user right now.
 * A user can accumulate several rows over time (upgrade, cancel, resub),
 * so pick by precedence rather than by insertion order: a live paying
 * row beats a trial, which beats anything cancelled. Ties break on the
 * later current_period_end, so the most recent row wins.
 */
function subscriptionIndex(subs) {
  const rank = sub => {
    const s = String(sub.status || '').toLowerCase().trim();
    if (s === 'past_due') return 3;
    if (isPayingStatus(s)) return 4;
    if (isTrialStatus(s)) return 2;
    if (isCanceledStatus(s)) return 0;
    return 1;
  };
  const byUser = new Map();
  (subs || []).forEach(sub => {
    if (!sub.user_id) return;
    const current = byUser.get(sub.user_id);
    if (!current) { byUser.set(sub.user_id, sub); return; }
    const a = rank(sub), b = rank(current);
    if (a > b) { byUser.set(sub.user_id, sub); return; }
    if (a < b) return;
    const ta = new Date(sub.current_period_end || sub.created_at || 0).getTime() || 0;
    const tb = new Date(current.current_period_end || current.created_at || 0).getTime() || 0;
    if (ta > tb) byUser.set(sub.user_id, sub);
  });
  return byUser;
}

/** Soft-delete guard: keep rows explicitly not deleted, or null. */
function excludeDeleted(query) {
  return query.or('is_deleted.is.false,is_deleted.is.null');
}

function ownerOf(project) {
  // PostgREST returns an embedded to-one relation as an object, but
  // returns an array when it cannot prove the relation is to-one.
  const u = project && project.users;
  if (Array.isArray(u)) return u[0] || {};
  return u || {};
}

function fmtDate(value) {
  if (!value) return 'N/A';
  const d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function durationBetween(start, end) {
  if (!start || !end) return null;
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (isNaN(a) || isNaN(b) || b < a) return null;
  const secs = Math.round((b - a) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/**
 * One row per deck project, newest first. Soft-deleted projects are
 * excluded so the panel's counts match what the app itself shows.
 */
async function getCandidates(supabase) {
  const [projectsRes, subsRes, paymentsRes, creditsRes] = await Promise.all([
    excludeDeleted(
      supabase.from(TABLES.PROJECTS).select(PROJECT_SELECT)
    ).order('created_at', { ascending: false }),
    supabase.from(TABLES.SUBSCRIPTIONS)
      .select('user_id, status, plan, stripe_subscription_id, created_at, current_period_end'),
    supabase.from(TABLES.PAYMENTS)
      .select('user_id, amount_inr, created_at, razorpay_payment_id'),
    supabase.from(TABLES.DECK_CREDITS)
      .select('user_id, status, amount_inr, razorpay_payment_id')
  ]);

  if (projectsRes.error) throw projectsRes.error;
  // Billing is secondary to the record list: if the subscriptions table
  // is unreadable (a policy covering projects but not subscriptions, for
  // instance), still show who used the tool rather than failing the whole
  // view into mock data. Every row then reports payment as unknown.
  const subsReadable = !subsRes.error;
  const paymentsReadable = !paymentsRes.error;
  if (!subsReadable) {
    console.warn(`[db7] subscriptions unreadable: ${subsRes.error.message}`);
  }
  if (!paymentsReadable) {
    console.warn(`[db7] payments unreadable: ${paymentsRes.error.message}`);
  }
  const subsByUser = subsReadable ? subscriptionIndex(subsRes.data) : null;
  const paidByUser = paymentsReadable ? paymentTotalsByUser(paymentsRes.data) : null;
  // Users who opened Razorpay checkout but never completed it.
  const abandonedByUser = new Set();
  if (!creditsRes.error) {
    (creditsRes.data || []).forEach(o => {
      const done = String(o.status || '').toLowerCase() === 'consumed' || !!o.razorpay_payment_id;
      if (!done && o.user_id) abandonedByUser.add(o.user_id);
    });
  }

  return (projectsRes.data || []).map(project => {
    const owner = ownerOf(project);
    const deckName = project.name || 'Untitled deck';
    const ownerName = owner.name || owner.email || 'Unknown owner';
    // A captured Razorpay payment is the strongest evidence that this
    // user paid, and it carries a real rupee figure, so it outranks the
    // subscription row. Fall back to the subscription state, then to
    // "Free", and only say "Unknown" when neither table could be read.
    const paid = paidByUser && paidByUser.get(project.user_id);
    let payment;
    if (paid && paid.total > 0) {
      payment = {
        label: `Paid ${formatInr(paid.total)}`,
        tone: 'high',
        status: 'paid',
        plan: null,
        periodEnd: null,
        amountInr: paid.total,
        paymentCount: paid.count,
        lastPaymentAt: paid.last
      };
    } else if (abandonedByUser.has(project.user_id)) {
      // Reached the payment page and didn't pay — worth chasing, and
      // very different from someone who never tried.
      payment = { label: 'Checkout abandoned', tone: 'medium', status: 'abandoned', plan: null, periodEnd: null };
    } else if (subsByUser) {
      payment = paymentBadge(subsByUser.get(project.user_id));
    } else if (paidByUser) {
      payment = { label: 'Free', tone: 'low', status: 'none', plan: null, periodEnd: null };
    } else {
      payment = { label: 'Unknown', tone: 'low', status: 'unreadable', plan: null, periodEnd: null };
    }

    return {
      id: String(project.id),
      name: `${ownerName} (${deckName})`,
      email: owner.email || 'No Email',
      // No phone column exists anywhere in this project's schema.
      phone: 'N/A',
      testDate: project.created_at,
      score: progressScore(project.status),
      maxScore: MAX_SCORE,

      // --- db7-specific row display (optional panel fields) ---
      // There is no score here, so the Score column shows the deck's own
      // generation state and the Status column shows what the panel
      // actually wants to know about a paid product: is this user paying?
      scoreLabel: progressLabel(project.status),
      statusLabel: payment.label,
      statusTone: payment.tone,
      payment
    };
  });
}

/**
 * Full detail for one deck project: the project, its owner, every
 * generation job run against it, and the owner's subscription.
 */
async function getCandidateDetails(supabase, candidateId) {
  const { data: project, error } = await supabase
    .from(TABLES.PROJECTS)
    .select(PROJECT_SELECT)
    .eq('id', candidateId)
    .single();

  if (error) throw error;

  const owner = ownerOf(project);

  // Jobs for this project. Best-effort: a deck with no job rows is a
  // normal state (never generated), so a failure here must not sink the
  // whole detail view.
  let jobs = [];
  try {
    const { data, error: jobsErr } = await supabase
      .from(TABLES.JOBS)
      .select('id, status, created_at, started_at, completed_at, error, result')
      .eq('project_id', project.id)
      .order('created_at', { ascending: false });
    if (!jobsErr) jobs = data || [];
  } catch (e) {
    jobs = [];
  }

  // Owner's subscription, likewise best-effort — a free user has none.
  let subscription = null;
  if (owner.id) {
    try {
      const { data, error: subErr } = await supabase
        .from(TABLES.SUBSCRIPTIONS)
        .select('id, status, plan, stripe_subscription_id, current_period_start, current_period_end, created_at')
        .eq('user_id', owner.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (!subErr && data && data.length) subscription = data[0];
    } catch (e) {
      subscription = null;
    }
  }

  const score = progressScore(project.status);

  const jobsAnswer = jobs.length
    ? jobs.map((job, i) => {
        const dur = durationBetween(job.started_at, job.completed_at);
        const parts = [
          `Run ${jobs.length - i}: ${job.status || 'no status'} (${progressLabel(job.status)})`,
          `   Queued:    ${fmtDate(job.created_at)}`,
          `   Started:   ${fmtDate(job.started_at)}`,
          `   Completed: ${fmtDate(job.completed_at)}${dur ? `  [took ${dur}]` : ''}`
        ];
        if (job.error) parts.push(`   Error: ${job.error}`);
        return parts.join('\n');
      }).join('\n\n')
    : 'No generation jobs have been run for this deck.';

  const results = [
    {
      question: 'Deck Project',
      answer: `Deck: ${project.name || 'Untitled deck'}\nProject ID: ${project.id}\nStatus: ${project.status || 'N/A'}\nCreated: ${fmtDate(project.created_at)}\nLast updated: ${fmtDate(project.updated_at)}`,
      score: null,
      maxScore: null
    },
    {
      question: 'Owner',
      answer: `Name: ${owner.name || 'N/A'}\nEmail: ${owner.email || 'N/A'}\nRole: ${owner.role || 'N/A'}\nAccount active: ${owner.is_active === false ? 'No' : owner.is_active === true ? 'Yes' : 'N/A'}\nUser ID: ${owner.id || 'N/A'}`,
      score: null,
      maxScore: null
    },
    {
      // Deliberately not called a score: this project stores no score of
      // any kind. See the header note on the progress mapping.
      question: 'Deck Generation Progress',
      answer: `Stage: ${progressLabel(project.status)}\nRaw status value: ${project.status || 'N/A'}\nProgress figure shown in the table: ${score}/${MAX_SCORE} (pipeline stage, not an assessment score)${project.error_message ? `\nLast error: ${project.error_message}` : ''}`,
      score: score,
      maxScore: MAX_SCORE
    },
    {
      question: 'Generation Jobs',
      answer: jobsAnswer,
      score: null,
      maxScore: null
    },
    {
      question: 'Subscription & Billing',
      answer: subscription
        ? `Plan: ${subscription.plan || 'N/A'}\nStatus: ${subscription.status || 'N/A'}\nCurrent period: ${fmtDate(subscription.current_period_start)} -> ${fmtDate(subscription.current_period_end)}\nStripe subscription: ${subscription.stripe_subscription_id || 'N/A'}\nStripe customer: ${owner.stripe_customer_id || 'N/A'}`
        : `No subscription row for this user${owner.stripe_customer_id ? `\nStripe customer: ${owner.stripe_customer_id}` : ''}`,
      score: null,
      maxScore: null
    }
  ];

  return {
    personalInfo: {
      id: String(project.id),
      name: owner.name || owner.email || 'Unknown owner',
      email: owner.email || 'No Email',
      testDate: project.created_at,
      score: score,
      maxScore: MAX_SCORE,
      sessionId: String(project.id),
      // No screenshot/thumbnail column exists in this schema, so the PDF
      // route falls through to its own rendering path.
      screenshotUrl: null
    },
    results
  };
}

/**
 * Per-user breakdown (Phase 5). projects.user_id is a stable user id, so
 * unlike db6 this tool supports real user monitoring: "attempts" here
 * means decks created.
 */
async function getUserBreakdown(supabase) {
  const { data, error } = await excludeDeleted(
    supabase.from(TABLES.PROJECTS).select('user_id, status, created_at, is_deleted, users ( name, email )')
  );

  if (error) throw error;

  const userMap = {};
  (data || []).forEach(row => {
    const owner = ownerOf(row);
    const key = row.user_id || owner.email || 'Unknown';
    if (!userMap[key]) {
      userMap[key] = {
        userId: key,
        name: owner.name || owner.email || 'Unknown',
        attempts: 0,
        scoreSum: 0,
        lastActivity: null
      };
    }
    userMap[key].attempts++;
    userMap[key].scoreSum += progressScore(row.status);
    if (row.created_at) {
      const d = new Date(row.created_at);
      if (!userMap[key].lastActivity || d > new Date(userMap[key].lastActivity)) {
        userMap[key].lastActivity = row.created_at;
      }
    }
  });

  const users = Object.values(userMap);
  return {
    totalUniqueUsers: users.length,
    averageAttemptsPerUser: users.length > 0
      ? Math.round((users.reduce((s, u) => s + u.attempts, 0) / users.length) * 10) / 10
      : 0,
    users: users.map(u => ({
      userId: u.userId,
      name: u.name,
      attempts: u.attempts,
      averageScore: Math.round(u.scoreSum / u.attempts),
      lastActivity: u.lastActivity
    })).sort((a, b) => b.attempts - a.attempts)
  };
}

/**
 * Repeat-usage retention cohort (Phase 6). For this tool the cohort
 * question is "did the user come back and start ANOTHER deck within
 * 1/7/30 days of their first", which is closer to real product retention
 * than the assessment tools' version — but it is still creation-based,
 * not login-based: there is no session data here either.
 */
async function getRetentionCohort(supabase) {
  const { data, error } = await excludeDeleted(
    supabase.from(TABLES.PROJECTS).select('user_id, created_at, is_deleted')
  );

  if (error) throw error;
  return buildRetentionCohort(data, 'user_id', 'created_at');
}

/**
 * Payment monitoring.
 *
 * WHAT THE PAYMENT INTEGRATION ACTUALLY IS (probed live, read-only):
 * Stripe, subscription-based. users.stripe_customer_id holds the Stripe
 * Customer; subscriptions holds one row per subscription with plan,
 * status, stripe_subscription_id and the current period window. That is
 * the whole of it — the classic "Stripe webhook mirrors subscription
 * state into Postgres" setup.
 *
 * WHAT IS NOT IN THE DATABASE, verified by probing for every plausible
 * column and table name:
 *   - no amount / price / unit_amount / currency anywhere
 *   - no invoices, charges, payments, transactions, receipts or
 *     checkout_sessions table
 *   - no price_id or product_id to join a price onto
 *   - no revenue/MRR RPC
 * So revenue and MRR are NOT derivable from this project. The amounts
 * live in Stripe only. To show real revenue the panel would need either
 * a plan -> price map configured here, or a Stripe secret key and a call
 * to the Stripe API. hasRevenueAmount stays false until then, which is
 * why no revenue KPI is rendered for this tool.
 *
 * WHAT IS derivable, and is returned below: subscriber counts by status
 * and by plan, trial vs paying, cancellations, upcoming renewals, and
 * checkout reach (users who ever got a Stripe customer id).
 *
 * The first four fields are the panel-wide payment contract that
 * db1-db5 also return; everything after them is extra detail the
 * Analytics view renders only when present.
 */

// Paying = money has actually moved. Trialing is deliberately NOT paying.
// past_due IS counted: the subscription is still live and was being paid
// until a failed charge, so treating it as "not a customer" would
// understate conversion.
function isPayingStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  return s === 'active' || s === 'paid' || s === 'current' || s === 'succeeded' || s === 'past_due';
}

function isTrialStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  return s === 'trialing' || s === 'trial' || s === 'in_trial';
}

function isCanceledStatus(status) {
  const s = String(status || '').toLowerCase().trim();
  return s === 'canceled' || s === 'cancelled' || s === 'incomplete_expired' || s === 'unpaid' || s === 'ended';
}

function countBy(rows, keyFn) {
  const map = {};
  rows.forEach(row => {
    const k = keyFn(row) || 'unknown';
    map[k] = (map[k] || 0) + 1;
  });
  return map;
}

async function getPaymentSummary(supabase) {
  const [usersRes, subsRes, paymentsRes, creditsRes] = await Promise.all([
    supabase.from(TABLES.USERS).select('id, stripe_customer_id'),
    supabase.from(TABLES.SUBSCRIPTIONS)
      .select('user_id, status, plan, stripe_subscription_id, current_period_start, current_period_end'),
    supabase.from(TABLES.PAYMENTS)
      .select('user_id, amount_inr, created_at, razorpay_payment_id, razorpay_order_id'),
    supabase.from(TABLES.DECK_CREDITS)
      .select('user_id, deck_type, amount_inr, status, razorpay_payment_id, created_at')
  ]);

  if (usersRes.error) throw usersRes.error;
  if (subsRes.error) throw subsRes.error;
  // Razorpay rows are what carry the money. If they cannot be read, fall
  // back to subscription-only reporting rather than failing the view.
  const paymentsReadable = !paymentsRes.error;
  if (!paymentsReadable) {
    console.warn(`[db7] payments unreadable, revenue will be omitted: ${paymentsRes.error.message}`);
  }

  const users = usersRes.data || [];
  const subs = subsRes.data || [];
  const payments = paymentsReadable ? (paymentsRes.data || []) : [];
  const creditsReadable = !creditsRes.error;
  const credits = creditsReadable ? (creditsRes.data || []) : [];

  const payingUsers = new Set();
  const trialUsers = new Set();
  subs.forEach(sub => {
    if (!sub.user_id) return;
    if (isPayingStatus(sub.status)) payingUsers.add(sub.user_id);
    else if (isTrialStatus(sub.status)) trialUsers.add(sub.user_id);
  });
  // Anyone with a captured Razorpay payment counts as a payer too, even
  // with no subscription row — these are one-off purchases.
  const razorpayPayers = new Set();
  let totalRevenue = 0;
  let revenue30d = 0;
  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
  payments.forEach(row => {
    const amount = Number(row.amount_inr) || 0;
    totalRevenue += amount;
    if (row.user_id) razorpayPayers.add(row.user_id);
    const t = new Date(row.created_at).getTime();
    if (!isNaN(t) && t >= cutoff30d) revenue30d += amount;
  });
  razorpayPayers.forEach(id => payingUsers.add(id));

  // Captured vs abandoned checkout orders.
  const isPaidOrder = o => String(o.status || '').toLowerCase() === 'consumed' || !!o.razorpay_payment_id;
  const paidOrders = credits.filter(isPaidOrder);
  const abandonedOrders = credits.filter(o => !isPaidOrder(o));

  const totalUsers = users.length;
  const paidCount = payingUsers.size;
  // Guard against a subscription whose user row is not visible (RLS) —
  // never report more payers than users.
  const unpaidCount = Math.max(0, totalUsers - paidCount);
  const total = Math.max(totalUsers, paidCount);

  // Upcoming renewals / lapsed periods, from the period window.
  const now = Date.now();
  const in30d = now + 30 * 24 * 60 * 60 * 1000;
  let renewalsNext30d = 0;
  let lapsedPeriod = 0;
  subs.forEach(sub => {
    if (!sub.current_period_end) return;
    const end = new Date(sub.current_period_end).getTime();
    if (isNaN(end)) return;
    if (end >= now && end <= in30d) renewalsNext30d++;
    // Period already ended but the row still claims a paying status —
    // usually a webhook that never arrived. Worth surfacing.
    if (end < now && isPayingStatus(sub.status)) lapsedPeriod++;
  });

  const statusCounts = countBy(subs, s => String(s.status || '').toLowerCase().trim());
  const planCounts = countBy(subs, s => s.plan);

  // Reuses the panel's existing "Unpaid breakdown: ..." line, which
  // renders [{ count, status }] — here, the non-paying subscription states.
  const unpaidBreakdown = Object.entries(statusCounts)
    .filter(([status]) => !isPayingStatus(status))
    .map(([status, count]) => ({ status: status || 'unknown', count }))
    .sort((a, b) => b.count - a.count);

  return {
    // --- panel-wide payment contract ---
    // The Razorpay table carries a real rupee amount (amount_inr), so
    // unlike most tools here this one CAN report revenue. If that table
    // was unreadable, drop back to counts only rather than showing 0.
    hasRevenueAmount: paymentsReadable,
    totalRevenue,
    paidCount,
    unpaidCount,
    paymentRate: total > 0 ? Math.round((paidCount / total) * 100) : 0,
    unpaidBreakdown,

    // --- db7-specific subscription billing detail ---
    billing: {
      provider: payments.length ? 'Razorpay' : 'Razorpay + Stripe (no rows yet)',
      model: 'one-off payments (Razorpay) + subscriptions (Stripe-shaped)',
      revenueAvailable: paymentsReadable,
      revenueNote: paymentsReadable
        ? 'Revenue is the sum of payments.amount_inr — captured Razorpay payments recorded in this database. The subscriptions table is Stripe-shaped and has no amount column, so any subscription billing is counted in the subscriber figures but contributes no rupee amount here.'
        : 'The payments table could not be read with this key, so revenue is unavailable. Subscriber counts below come from the subscriptions table only.',
      // --- Razorpay (one-off payments, real money) ---
      razorpayPayments: payments.length,
      razorpayPayers: razorpayPayers.size,
      totalRevenueInr: totalRevenue,
      revenueLast30dInr: revenue30d,
      averagePaymentInr: payments.length ? Math.round(totalRevenue / payments.length) : 0,
      // --- Stripe-shaped subscriptions ---
      totalUsers,
      subscriptionRows: subs.length,
      activeSubscribers: paidCount,
      trialingSubscribers: trialUsers.size,
      canceledSubscriptions: subs.filter(s => isCanceledStatus(s.status)).length,
      pastDueSubscriptions: subs.filter(s => String(s.status || '').toLowerCase().trim() === 'past_due').length,
      renewalsNext30d,
      lapsedPeriod,
      // Users who reached Stripe checkout at least once, whether or not
      // they ended up with a subscription row.
      checkoutReach: users.filter(u => !!u.stripe_customer_id).length,

      // --- Razorpay checkout funnel (deck_credits) ---
      // An order row that never reached 'consumed' and carries no
      // razorpay_payment_id is someone who opened checkout and walked
      // away. That is the single most actionable number on this page:
      // named people who wanted to pay and didn't.
      checkoutFunnelAvailable: creditsReadable,
      ordersCreated: credits.length,
      ordersPaid: paidOrders.length,
      ordersAbandoned: abandonedOrders.length,
      abandonedValueInr: abandonedOrders.reduce((sum, o) => sum + (Number(o.amount_inr) || 0), 0),
      checkoutConversionRate: credits.length ? Math.round((paidOrders.length / credits.length) * 100) : 0,
      abandonedByDeckType: Object.entries(
        abandonedOrders.reduce((acc, o) => {
          const k = o.deck_type || 'unknown';
          acc[k] = (acc[k] || 0) + 1;
          return acc;
        }, {})
      ).map(([deckType, count]) => ({ deckType, count })).sort((a, b) => b.count - a.count),
      statusBreakdown: Object.entries(statusCounts)
        .map(([status, count]) => ({ status: status || 'unknown', count }))
        .sort((a, b) => b.count - a.count),
      planBreakdown: Object.entries(planCounts)
        .map(([plan, count]) => ({
          plan,
          count,
          payingCount: subs.filter(s => (s.plan || 'unknown') === plan && isPayingStatus(s.status)).length
        }))
        .sort((a, b) => b.count - a.count)
    }
  };
}

/**
 * NOT IMPLEMENTED, and why — so the next person does not read these as
 * oversights (server.js feature-detects every one of them, so leaving
 * them off simply hides that feature for this tool):
 *
 *   getOrgBreakdown      - no organization/company column on any table.
 *                          Grouping by email domain was considered and
 *                          rejected: it would invent an org dimension
 *                          this schema does not have.
 *   getDimensionAverages - no per-dimension sub-scores (no scores at all).
 */

function getMockCandidates() {
  return [
    { id: 'db7-proj-1', name: 'Ananya Rao (Series A — FinEdge)', email: 'ananya@finedge.io', phone: 'N/A', testDate: '2026-11-14T09:20:00Z', score: 100, maxScore: 100, scoreLabel: 'Completed', statusLabel: 'Paid ₹9,995', statusTone: 'high', payment: { label: 'Paid ₹9,995', tone: 'high', status: 'paid', plan: null, periodEnd: null, amountInr: 9995, paymentCount: 5, lastPaymentAt: '2026-11-14T09:20:00Z' } },
    { id: 'db7-proj-2', name: 'Vikram Shetty (Seed Deck — LoopLogistics)', email: 'vikram@looplogistics.in', phone: 'N/A', testDate: '2026-11-12T16:05:00Z', score: 50, maxScore: 100, scoreLabel: 'In progress', statusLabel: 'Trial — pro', statusTone: 'medium', payment: { label: 'Trial — pro', tone: 'medium', status: 'trialing', plan: 'pro', periodEnd: '2026-11-26T16:05:00Z' } },
    { id: 'db7-proj-3', name: 'Priya Menon (Investor Update Q3)', email: 'priya@menonhealth.co', phone: 'N/A', testDate: '2026-11-09T11:45:00Z', score: 0, maxScore: 100, scoreLabel: 'Failed', statusLabel: 'Free', statusTone: 'low', payment: { label: 'Free', tone: 'low', status: 'none', plan: null, periodEnd: null } }
  ];
}

function getMockCandidateDetails(candidateId) {
  const candidates = getMockCandidates();
  const personalInfo = candidates.find(c => c.id === candidateId) || candidates[0];

  return {
    personalInfo: {
      ...personalInfo,
      name: personalInfo.name.split(' (')[0],
      sessionId: personalInfo.id,
      screenshotUrl: null
    },
    results: [
      {
        question: 'Deck Project',
        answer: 'Deck: Series A — FinEdge\nProject ID: db7-proj-1\nStatus: completed\nCreated: 2026-11-14 09:20 UTC\nLast updated: 2026-11-14 09:34 UTC',
        score: null,
        maxScore: null
      },
      {
        question: 'Owner',
        answer: 'Name: Ananya Rao\nEmail: ananya@finedge.io\nRole: owner\nAccount active: Yes\nUser ID: 8f2c-mock',
        score: null,
        maxScore: null
      },
      {
        question: 'Deck Generation Progress',
        answer: `Stage: Completed\nRaw status value: completed\nProgress figure shown in the table: ${personalInfo.score}/100 (pipeline stage, not an assessment score)`,
        score: personalInfo.score,
        maxScore: 100
      },
      {
        question: 'Generation Jobs',
        answer: 'Run 2: completed (Completed)\n   Queued:    2026-11-14 09:30 UTC\n   Started:   2026-11-14 09:30 UTC\n   Completed: 2026-11-14 09:34 UTC  [took 3m 48s]\n\nRun 1: failed (Failed)\n   Queued:    2026-11-14 09:22 UTC\n   Started:   2026-11-14 09:22 UTC\n   Completed: 2026-11-14 09:23 UTC  [took 41s]\n   Error: upstream model timeout',
        score: null,
        maxScore: null
      },
      {
        question: 'Subscription & Billing',
        answer: 'Plan: pro\nStatus: active\nCurrent period: 2026-11-01 00:00 UTC -> 2026-12-01 00:00 UTC\nStripe subscription: sub_mock123\nStripe customer: cus_mock123',
        score: null,
        maxScore: null
      }
    ]
  };
}

function getMockPaymentSummary() {
  return {
    hasRevenueAmount: true,
    totalRevenue: 11994,
    paidCount: 2,
    unpaidCount: 4,
    paymentRate: 33,
    unpaidBreakdown: [{ status: 'trialing', count: 2 }, { status: 'canceled', count: 1 }],
    billing: {
      provider: 'Razorpay',
      model: 'one-off payments (Razorpay) + subscriptions (Stripe-shaped)',
      revenueAvailable: true,
      revenueNote: 'Revenue is the sum of payments.amount_inr — captured Razorpay payments recorded in this database. The subscriptions table is Stripe-shaped and has no amount column, so any subscription billing is counted in the subscriber figures but contributes no rupee amount here.',
      razorpayPayments: 6,
      razorpayPayers: 2,
      totalRevenueInr: 11994,
      revenueLast30dInr: 3998,
      averagePaymentInr: 1999,
      totalUsers: 6,
      subscriptionRows: 5,
      activeSubscribers: 2,
      trialingSubscribers: 2,
      canceledSubscriptions: 1,
      pastDueSubscriptions: 0,
      renewalsNext30d: 2,
      lapsedPeriod: 0,
      checkoutReach: 4,
      statusBreakdown: [
        { status: 'active', count: 2 },
        { status: 'trialing', count: 2 },
        { status: 'canceled', count: 1 }
      ],
      planBreakdown: [
        { plan: 'pro', count: 3, payingCount: 2 },
        { plan: 'starter', count: 2, payingCount: 0 }
      ]
    }
  };
}

module.exports = {
  getCandidates,
  getCandidateDetails,
  getMockCandidates,
  getMockCandidateDetails,
  getUserBreakdown,
  getRetentionCohort,
  getPaymentSummary,
  getMockPaymentSummary,
  metadata: {
    name: 'Pitch Deck Builder',
    category: 'Product',
    // VERIFIED live: the product is branded "Mint" and is served from
    // .com, not the .co.in the other tools use. Its frontend talks only to
    // a Cloud Run API (pitch-deck-backend-...asia-northeast1.run.app),
    // never to Supabase directly.
    siteUrl: 'https://pitchdeck.infopaceindia.com',
    description: 'AI pitch deck builder — tracks deck projects, their generation jobs, and Razorpay payments (plus a Stripe-shaped subscriptions table) per user.',
    // Relabels two columns of the shared record table for this tool only.
    // Adapters that omit this keep the default Score / Status headers.
    candidateColumns: {
      name: 'User & Deck',
      score: 'Deck Status',
      status: 'Payment'
    }
  }
};
