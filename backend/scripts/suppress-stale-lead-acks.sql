-- One-off backlog cleanup — NOT a schema migration, so it isn't numbered
-- alongside migrations/001-005. Run it by hand in the Supabase SQL editor
-- for the SOCIAL project (same one as those migrations).
--
-- WHY THIS EXISTS
-- Render's free web services block outbound traffic to SMTP ports
-- 25/465/587, so every lead email failed with a connect timeout for as
-- long as the backend was pointed at smtp.office365.com. Those leads are
-- all still sitting at lead_ack_sent = false, and
-- retryPendingNotifications() in backend/leads/poller.js re-attempts
-- every one of them on each 5 min sweep. The moment Microsoft Graph
-- credentials go live, that backlog flushes — meaning someone who filled
-- the form weeks ago receives "a member of our team will contact you
-- shortly", which is worse than silence.
--
-- This marks the *customer-facing acknowledgement* as handled for leads
-- older than a cutoff, so the poller stops trying to send it.
--
-- It deliberately leaves internal_notify_sent alone: the internal sales
-- alert going out late is useful, not embarrassing, and suppressing it
-- would hide real leads from the team. Those still flush on the next
-- sweep, or via POST /api/leads/notify-pending for one digest instead of
-- one email per lead.

-- ─── STEP 1: look before you write ──────────────────────────────────────
-- How big is the backlog, and how old? Run this alone first.
select
  count(*)                                                        as pending_acks,
  count(*) filter (where created_time >= now() - interval '2 days') as last_2_days,
  count(*) filter (where created_time <  now() - interval '2 days') as older,
  min(created_time)                                               as oldest,
  max(created_time)                                               as newest
from leads
where lead_ack_sent = false
  and email is not null
  and email <> '';

-- The individual rows that STEP 3 would suppress, so the cutoff can be
-- sanity-checked against real dates before anything is updated. Adjust
-- the interval here and in STEP 3 together.
select id, created_time, full_name, email, status
from leads
where lead_ack_sent = false
  and email is not null
  and email <> ''
  and created_time < now() - interval '2 days'
order by created_time;

-- ─── STEP 2: pick the cutoff ────────────────────────────────────────────
-- '2 days' is a starting point, not a recommendation — a lead from
-- yesterday still reads as a reasonable response time; one from last
-- month does not. Replace the interval in STEP 3 with whatever STEP 1's
-- date range makes defensible.

-- ─── STEP 3: suppress the stale acknowledgements ────────────────────────
-- Returns the rows it changed, so the count can be checked against
-- STEP 1's `older` figure. Wrapped in an explicit transaction: inspect
-- the output, then COMMIT (or ROLLBACK to back out with no trace).
begin;

update leads
set lead_ack_sent = true
where lead_ack_sent = false
  and email is not null
  and email <> ''
  and created_time < now() - interval '2 days'
returning id, created_time, email;

-- Replace with ROLLBACK; if the row count or dates look wrong.
commit;

-- ─── STEP 4: confirm ────────────────────────────────────────────────────
-- What the poller will actually send once Graph is live. These are the
-- recent leads that genuinely should still get an acknowledgement.
select id, created_time, full_name, email
from leads
where lead_ack_sent = false
  and email is not null
  and email <> ''
order by created_time;
