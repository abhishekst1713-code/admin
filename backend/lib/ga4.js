/**
 * GA4 Acquisition — Phase 7 (Not Feasible From Supabase Alone).
 *
 * Every db1-db6 adapter only sees a visitor once they submit a completed
 * assessment — nothing in any Supabase table records a landing-page
 * view, a bounce, or an assessment that was started but abandoned. That
 * data can only come from web analytics installed on the actual
 * candidate-facing sites (cii.infopaceindia.co.in, etc.), which live in
 * separate deployments this repo has no access to.
 *
 * This module is scaffolding for once GA4 is actually installed on those
 * sites: it wraps the GA4 Data API (server-side reporting, not the
 * gtag.js snippet itself — that has to be added to each site directly).
 * Until GA4_SERVICE_ACCOUNT_KEY and a per-tool GA4_PROPERTY_ID_<n> are
 * configured, isConfigured() returns false for every tool and the
 * server.js endpoint falls back to mock data, same pattern as every
 * Supabase adapter's isMock fallback.
 *
 * Setup once real data exists:
 *   1. Add the GA4 (gtag.js) snippet to each of the 6 candidate-facing
 *      sites — outside this repo's control.
 *   2. Create a GA4 property per site (or reuse one with a Property ID
 *      per data stream) and a GCP service account with Viewer access to
 *      each property.
 *   3. Set GA4_SERVICE_ACCOUNT_KEY (the service account's JSON key,
 *      stringified) and GA4_PROPERTY_ID_1..GA4_PROPERTY_ID_7 in .env.
 *   4. Optionally fire a custom "assessment_started" GA4 event from each
 *      site so landingConversionRate below can be real instead of null —
 *      without it, GA4 only tells us sessions/users/bounce, not how many
 *      of those visitors ever opened the assessment.
 */

const { BetaAnalyticsDataClient } = require('@google-analytics/data');

let cachedClient = null;
let clientInitFailed = false;

function getClient() {
  if (clientInitFailed) return null;
  if (cachedClient) return cachedClient;

  const rawKey = process.env.GA4_SERVICE_ACCOUNT_KEY;
  if (!rawKey) return null;

  try {
    const credentials = JSON.parse(rawKey);
    cachedClient = new BetaAnalyticsDataClient({ credentials });
    return cachedClient;
  } catch (err) {
    console.error('GA4_SERVICE_ACCOUNT_KEY is set but not valid JSON — acquisition data will stay in mock mode:', err.message);
    clientInitFailed = true;
    return null;
  }
}

function getPropertyId(dbId) {
  const n = dbId.replace('db', '');
  return process.env[`GA4_PROPERTY_ID_${n}`] || null;
}

function isConfigured(dbId) {
  return !!(process.env.GA4_SERVICE_ACCOUNT_KEY && getPropertyId(dbId));
}

/**
 * Pulls the last `days` days of core acquisition metrics for one tool's
 * GA4 property. landingConversionRate is only populated if the site
 * fires a custom "assessment_started" event — most sites won't yet, so
 * it comes back null rather than a fabricated number.
 */
async function getAcquisitionSummary(dbId, days = 7) {
  const client = getClient();
  const propertyId = getPropertyId(dbId);
  if (!client || !propertyId) {
    throw new Error(`GA4 not configured for ${dbId} (missing GA4_SERVICE_ACCOUNT_KEY or GA4_PROPERTY_ID_${dbId.replace('db', '')})`);
  }

  const dateRange = [{ startDate: `${days}daysAgo`, endDate: 'today' }];

  const [overview, channels, conversions] = await Promise.all([
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: dateRange,
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'bounceRate' }]
    }),
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: dateRange,
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 6
    }),
    client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: dateRange,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: { fieldName: 'eventName', stringFilter: { value: 'assessment_started' } }
      }
    }).catch(() => null) // custom event may not exist yet — not fatal
  ]);

  const row = overview[0].rows && overview[0].rows[0];
  const activeUsers = row ? Number(row.metricValues[0].value) : 0;
  const sessions = row ? Number(row.metricValues[1].value) : 0;
  const bounceRate = row ? Math.round(Number(row.metricValues[2].value) * 100) : null;

  const channelBreakdown = (channels[0].rows || []).map(r => ({
    channel: r.dimensionValues[0].value,
    sessions: Number(r.metricValues[0].value)
  }));

  const startedCount = conversions && conversions[0].rows && conversions[0].rows[0]
    ? Number(conversions[0].rows[0].metricValues[0].value)
    : null;
  const landingConversionRate = startedCount !== null && sessions > 0
    ? Math.round((startedCount / sessions) * 100)
    : null;

  return { activeUsers, sessions, bounceRate, landingConversionRate, channelBreakdown };
}

function getMockAcquisitionSummary() {
  return {
    activeUsers: 0,
    sessions: 0,
    bounceRate: null,
    landingConversionRate: null,
    channelBreakdown: []
  };
}

module.exports = { isConfigured, getAcquisitionSummary, getMockAcquisitionSummary };
