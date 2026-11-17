/**
 * Schema Audit — Phase 0 (+ Phase 6/7 payment column check)
 *
 * For each assessment Supabase project, checks whether the main table
 * has what's needed to build:
 *   - Funnel / In-Progress / Abandoned counts   -> needs a status/stage column
 *   - Time monitoring (avg/median duration)     -> needs started_at AND completed_at
 *   - Organization monitoring                   -> needs an org/company id or name column
 *   - User monitoring (repeat attempts, etc.)   -> needs a stable user/candidate id
 *   - Payment monitoring                        -> needs a paid/payment-status column
 *
 * This does NOT modify anything — it only reads one row's column names
 * (`select('*').limit(1)`) from each main table and reports what it finds.
 * A "could not find the table" error here is the audit doing its job:
 * it means the table name below doesn't match the live schema, which is
 * exactly what happened with db6's guessed "submissions" table and
 * db2/db5's guessed "paid" column — both need a live audit run to fix,
 * not another guess.
 *
 * Usage:
 *   1. Put this file in backend/ (next to server.js and adapters/)
 *   2. Make sure backend/.env has SUPABASE_URL_1..6 and SUPABASE_KEY_1..6 filled in
 *   3. node schema-audit.js
 *   4. If a table errors as "not found," edit its `table:` guess below to
 *      the real name (check Supabase Studio's table list) and re-run.
 */

const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// One "main table" per tool — the table each adapter's getCandidates()
// treats as the source of truth for a completed attempt. db6's table
// name is UNCONFIRMED — "submissions" errored as not-found live, so
// this is a guess to fix, not a known-good value.
const TOOLS = [
    { dbId: 'db1', name: 'Creative and Innovation', table: 'cii_results' },
    { dbId: 'db2', name: 'Founder and Co-founder Compatibility', table: 'sessions' },
    { dbId: 'db3', name: 'Market Research', table: 'research_submissions' },
    { dbId: 'db4', name: 'Market Potential', table: 'submissions' },
    { dbId: 'db5', name: 'Venture Risk Assessment', table: 'assessments' },
    // db6 disabled in server.js — "submissions" is not the real table name.
    // { dbId: 'db6', name: 'Personality', table: 'submissions' },
    // db7 is not an assessment: its main table is projects (one row per
    // deck), joined to users. Audited live 2026-11-17 — the anon key sees
    // 0 rows in all of users/projects/jobs/subscriptions, so this will
    // report "empty" until a service_role key is used (or data exists).
    { dbId: 'db7', name: 'Pitch Deck Builder', table: 'projects' }
];

// Keyword groups used to fuzzy-match column names to each capability.
// Adjust these if your actual column names use different conventions.
const KEYWORDS = {
    status: ['status', 'stage', 'state', 'is_completed', 'is_abandoned', 'completion_status'],
    startedAt: ['started_at', 'start_time', 'created_at', 'begin_at'],
    completedAt: ['completed_at', 'finished_at', 'end_time', 'submitted_at'],
    organization: ['organization', 'org_id', 'organisation', 'company', 'company_id', 'employer'],
    userId: ['user_id', 'candidate_id', 'employee_id', 'respondent_id'],
    payment: ['paid', 'payment', 'is_paid', 'purchase', 'transaction', 'amount_paid']
};

function findMatches(columns, keywords) {
    return columns.filter(col =>
        keywords.some(kw => col.toLowerCase().includes(kw))
    );
}

// PostgREST (what Supabase's REST API runs on) serves an OpenAPI doc at
// its root listing every table it exposes — asking it directly beats
// guessing a second table name after the first guess was wrong (db6's
// "submissions" wasn't it). Best-effort: returns null on any failure so
// a working audit never breaks because this extra probe didn't work.
async function listAvailableTables(url, key) {
    try {
        const res = await fetch(`${url}/rest/v1/`, {
            headers: { apikey: key, Authorization: `Bearer ${key}` }
        });
        if (!res.ok) return null;
        const spec = await res.json();
        if (!spec.paths) return null;
        return Object.keys(spec.paths)
            .map(p => p.replace(/^\//, ''))
            .filter(p => p && !p.startsWith('rpc/'));
    } catch (err) {
        return null;
    }
}

async function auditTool({ dbId, name, table }) {
    const url = process.env[`SUPABASE_URL_${dbId.slice(2)}`];
    const key = process.env[`SUPABASE_KEY_${dbId.slice(2)}`];

    console.log(`\n=== ${name} (${dbId}) — table: "${table}" ===`);

    if (!url || !key) {
        console.log('  SKIPPED — no SUPABASE_URL/KEY configured in .env for this slot.');
        return { dbId, name, table, configured: false };
    }

    const supabase = createClient(url, key);

    const { data, error } = await supabase.from(table).select('*').limit(1);

    if (error) {
        console.log(`  ERROR querying "${table}": ${error.message}`);
        console.log('  -> Table name may differ from what the adapter expects, or credentials lack access.');
        const available = await listAvailableTables(url, key);
        if (available && available.length > 0) {
            console.log(`  Tables this project actually exposes: ${available.join(', ')}`);
            console.log(`  -> Update the "table:" guess for ${dbId} above to whichever of these is right, then re-run.`);
        } else {
            console.log('  Could not list available tables either — check the table name directly in Supabase Studio.');
        }
        return { dbId, name, table, configured: true, error: error.message };
    }

    if (!data || data.length === 0) {
        console.log(`  Table "${table}" is empty — cannot infer columns from a sample row.`);
        console.log('  -> Re-run once there is at least one row, or check the schema directly in Supabase Studio.');
        return { dbId, name, table, configured: true, empty: true };
    }

    const columns = Object.keys(data[0]);
    const statusCols = findMatches(columns, KEYWORDS.status);
    const startedCols = findMatches(columns, KEYWORDS.startedAt);
    const completedCols = findMatches(columns, KEYWORDS.completedAt);
    const orgCols = findMatches(columns, KEYWORDS.organization);
    const userCols = findMatches(columns, KEYWORDS.userId);
    const paymentCols = findMatches(columns, KEYWORDS.payment);

    console.log(`  All columns: ${columns.join(', ')}`);

    // JSONB columns (e.g. db2's founder_a/founder_b) hide their real
    // fields from a plain column list — a payment flag could easily live
    // inside one instead of on the row directly. Print the nested keys of
    // any object-valued column from this same sample row so that's not a
    // dead end.
    columns.forEach(col => {
        const val = data[0][col];
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            console.log(`  "${col}" is a JSON object — nested keys: ${Object.keys(val).join(', ') || '(empty)'}`);
        }
    });

    console.log(`  Status-like column(s):      ${statusCols.length ? statusCols.join(', ') : 'NONE FOUND'}`);
    console.log(`  Start-timestamp column(s):  ${startedCols.length ? startedCols.join(', ') : 'NONE FOUND'}`);
    console.log(`  Completion-timestamp col(s):${completedCols.length ? completedCols.join(', ') : 'NONE FOUND'}`);
    console.log(`  Organization column(s):     ${orgCols.length ? orgCols.join(', ') : 'NONE FOUND'}`);
    console.log(`  User/candidate id column(s):${userCols.length ? userCols.join(', ') : 'NONE FOUND'}`);
    console.log(`  Payment-like column(s):     ${paymentCols.length ? paymentCols.join(', ') : 'NONE FOUND'}`);

    const canDoFunnel = statusCols.length > 0;
    const canDoTime = startedCols.length > 0 && completedCols.length > 0;
    const canDoOrg = orgCols.length > 0;
    const canDoUser = userCols.length > 0;
    const canDoPayment = paymentCols.length > 0;

    console.log(`  -> Funnel/Abandoned monitoring:  ${canDoFunnel ? 'YES' : 'NOT YET (needs a status column)'}`);
    console.log(`  -> Time monitoring:              ${canDoTime ? 'YES' : 'NOT YET (needs both a start and completion timestamp)'}`);
    console.log(`  -> Organization monitoring:      ${canDoOrg ? 'YES' : 'NOT YET (needs an org/company column)'}`);
    console.log(`  -> User monitoring:              ${canDoUser ? 'YES' : 'NOT YET (needs a stable user/candidate id column)'}`);
    console.log(`  -> Payment monitoring:           ${canDoPayment ? 'YES' : 'NOT YET (needs a paid/payment-status column)'}`);
    if (canDoPayment) {
        console.log(`     NOTE: adapter code currently reads a hardcoded column name — if it isn't`);
        console.log(`     exactly "${paymentCols[0]}", update isPaidValue()'s .select() call in the adapter to match.`);
    }

    return {
        dbId, name, table, configured: true,
        columns, canDoFunnel, canDoTime, canDoOrg, canDoUser, canDoPayment
    };
}

async function main() {
    console.log(`Running schema audit across all ${TOOLS.length} tools...`);
    const results = [];
    for (const tool of TOOLS) {
        results.push(await auditTool(tool));
    }

    console.log('\n\n=== SUMMARY ===');
    console.log('Tool'.padEnd(38), 'Funnel'.padEnd(8), 'Time'.padEnd(8), 'Org'.padEnd(8), 'User'.padEnd(8), 'Payment');
    results.forEach(r => {
        if (!r.configured || r.error || r.empty) {
            console.log(r.name.padEnd(38), '- not enough data to assess -', r.error ? `(${r.error})` : '');
            return;
        }
        console.log(
            r.name.padEnd(38),
            (r.canDoFunnel ? 'YES' : 'NO').padEnd(8),
            (r.canDoTime ? 'YES' : 'NO').padEnd(8),
            (r.canDoOrg ? 'YES' : 'NO').padEnd(8),
            (r.canDoUser ? 'YES' : 'NO').padEnd(8),
            (r.canDoPayment ? 'YES' : 'NO')
        );
    });

    console.log('\nNote: keyword matching is a heuristic — if a column exists under a name');
    console.log('not covered by KEYWORDS above, it will show as NOT FOUND. Double check any');
    console.log('"NO" result against Supabase Studio directly before ruling out a feature.');
}

main();