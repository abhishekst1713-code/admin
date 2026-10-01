import React, { useState, useEffect } from 'react';
import {
  LayoutDashboard,
  Database,
  Settings,
  Download,
  Search,
  User,
  Mail,
  Calendar,
  Award,
  X,
  Check,
  AlertCircle,
  RefreshCw,
  ShieldAlert,
  BookOpen,
  Phone,
  TrendingUp,
  TrendingDown,
  Minus,
  FileCheck2,
  AlertTriangle,
  HeartPulse,
  BarChart3,
  ChevronDown,
  ChevronRight,
  ListChecks,
  CreditCard,
  Globe,
  CheckCircle2,
  Star,
  Building2,
  Target,
  LayoutGrid
} from 'lucide-react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RTooltip,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  LabelList,
  RadialBarChart,
  RadialBar
} from 'recharts';
import SocialNav from './social/SocialNav';
import Composer from './social/Composer';
import SocialPosts from './social/Posts';
import ConnectAccounts from './social/ConnectAccounts';
import Inbox from './social/Inbox';
import Analytics from './social/Analytics';
import SocialDashboard from './social/Dashboard';
import Leads from './leads/Leads';
import LeadsDashboard from './leads/Dashboard';

const API_BASE = `${import.meta.env.VITE_API_BASE || 'http://localhost:5000'}/api`;

// Validated per the dataviz skill (references/palette.md) — an 8-hue
// fixed categorical order (never cycled or reordered per series) for
// chart/tool identity, run through scripts/validate_palette.js against
// this app's surface before adoption. Re-validate if this list changes.
const CATEGORICAL_PALETTE = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
  '#4a3aa7', // 7 violet
  '#e34948'  // 8 red
];

// Shared chart palette — mirrors the CSS custom properties in index.css
// (kept as literal hex here since Recharts renders raw SVG and some
// browsers don't resolve var() inside SVG presentation attributes).
// success/warning/danger are UI-chrome status colors (icon badges,
// severity dots, tier colors) — the text/icon-safe darker step, so a
// white icon on top of a warning badge stays legible. They are never
// reused as a chart-series color; CATEGORICAL_PALETTE/TOOL_PALETTE do
// that job instead.
const CHART_COLORS = {
  primary: CATEGORICAL_PALETTE[0],
  secondary: CATEGORICAL_PALETTE[2],
  success: '#0ca30c',
  warning: '#b8690a',
  danger: '#d03b3b',
  muted: '#8991a6'
};

// The brighter chart-MARK version of the status palette (pie slices, bar
// fills) — always shown with a legend or direct label alongside, per the
// dataviz skill's relief rule, so the lighter/lower-contrast hex is fine
// here even though it isn't for a bare icon or text.
const STATUS_MARK_COLORS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b'
};

const TREND_RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'custom', label: 'Custom' }
];

// AI-profile list items (strengths/blindSpots/improvements) are usually
// plain strings, but some live tools return structured objects instead
// (observed shape: { dim, action }) — rendering an object directly as a
// React child crashes the page, so normalize whatever comes back to text.
function renderProfileListItem(item) {
  if (typeof item === 'string' || typeof item === 'number') return item;
  if (item && typeof item === 'object') {
    if (item.dim && item.action) return `${item.dim}: ${item.action}`;
    if (item.action) return item.action;
    if (item.dim) return item.dim;
    const textValues = Object.values(item).filter(v => typeof v === 'string');
    if (textValues.length > 0) return textValues.join(' — ');
    return JSON.stringify(item);
  }
  return String(item);
}

// "2 min ago" / "3 hours ago" style relative time for the activity feed.
function timeAgo(isoString) {
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (isNaN(diffMs)) return '';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isToday(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate();
}

// Live Activity "Today's Snapshot" (doc section 6) — derived client-side
// from the already-fetched activity feed rather than a new endpoint.
// Active Sessions / Currently Processing have no real value: reports
// generate synchronously (never queued), so those are always 0 — shown
// with a note rather than omitted, since the doc explicitly asks for them.
function TodaySnapshot({ activityData }) {
  const todays = activityData.filter(e => isToday(e.timestamp));
  const completedToday = todays.filter(e => e.type === 'assessment_completed').length;
  const reportsGeneratedToday = todays.filter(e => e.type === 'report_generated').length;
  const reportsFailedToday = todays.filter(e => e.type === 'report_failed').length;

  return (
    <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1rem', paddingBottom: '0.75rem', borderBottom: '1px solid var(--border-color)' }}>
      <span>Completed today: <strong>{completedToday}</strong></span>
      <span>Reports generated today: <strong>{reportsGeneratedToday}</strong></span>
      <span>Reports failed today: <strong>{reportsFailedToday}</strong></span>
      <span title="No session queue exists — every report request completes synchronously">Currently processing: <strong>0</strong></span>
      <span title="No session-tracking data exists yet — needs source-app instrumentation">Active sessions: <strong>N/A</strong></span>
    </div>
  );
}

// Real Tool Availability — pings the tool's actual public website,
// separate from the DB-query health pill next to it. A tool can be
// "healthy" on DB queries while its public site is suspended.
function AvailabilityPill({ availability }) {
  if (!availability) return null;
  const labels = { up: 'Site Up', suspended: 'Site Suspended', down: 'Site Down' };
  const classes = { up: 'healthy', suspended: 'critical', down: 'critical' };
  return (
    <span className={`health-status-pill ${classes[availability.status] || 'unknown'}`} title={availability.url}>
      {labels[availability.status] || 'Unknown'}
    </span>
  );
}

function TrendIndicator({ trend }) {
  if (!trend) return null;
  const { direction, changePercent } = trend;
  if (direction === 'up') {
    return <span className="trend-indicator up"><TrendingUp size={14} /> {changePercent}%</span>;
  }
  if (direction === 'down') {
    return <span className="trend-indicator down"><TrendingDown size={14} /> {Math.abs(changePercent)}%</span>;
  }
  return <span className="trend-indicator flat"><Minus size={14} /> Flat</span>;
}

// "2026-08-21" -> "Aug 21"
function formatShortDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Custom tooltip for the trend chart — keeps the per-tool breakdown that
// hovering a day already gave admins, now driven by Recharts instead of
// hand-rolled hover state.
function TrendTooltip({ active, payload, toolNames }) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const byToolEntries = point.byTool
    ? Object.entries(point.byTool).sort((a, b) => b[1] - a[1])
    : [];
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-header">
        {formatShortDate(point.date)} — {point.completed} total
      </div>
      {byToolEntries.length > 0 ? (
        <ul className="chart-tooltip-list">
          {byToolEntries.map(([dbId, count]) => (
            <li key={dbId}>
              <span>{(toolNames && toolNames[dbId]) || dbId}</span>
              <strong>{count}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <div className="chart-tooltip-empty">No activity</div>
      )}
    </div>
  );
}

// Usage trend — real area chart (Recharts) with a gradient fill. Thins out
// Range tabs (Today/7d/30d/90d/Custom) + the two date inputs that appear
// once "Custom" is selected. One shared component so the picker behaves
// identically everywhere it's used (Overview, Analytics all-tools,
// Analytics per-tool) instead of three copies drifting apart.
function TrendRangeSelector({ trendRange, setTrendRange, customStartDate, setCustomStartDate, customEndDate, setCustomEndDate }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
      <div className="range-tabs">
        {TREND_RANGES.map(r => (
          <button
            key={r.key}
            className={`range-tab ${trendRange === r.key ? 'active' : ''}`}
            onClick={() => setTrendRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {trendRange === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <input
            type="date"
            className="tool-select"
            value={customStartDate}
            max={customEndDate || todayStr}
            onChange={(e) => setCustomStartDate(e.target.value)}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>to</span>
          <input
            type="date"
            className="tool-select"
            value={customEndDate}
            min={customStartDate || undefined}
            max={todayStr}
            onChange={(e) => setCustomEndDate(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}

// X-axis labels on longer ranges so dates don't collide, same rule the old
// hand-rolled version used (label every ceil(n/9) points, always show the
// last/most-recent date).
function TrendChart({ series, toolNames }) {
  if (!series || series.length === 0) {
    return <div className="trend-chart-empty">No activity data for this range.</div>;
  }

  const labelEvery = Math.max(1, Math.ceil(series.length / 9));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={series} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLORS.primary} stopOpacity={0.12} />
            <stop offset="100%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border-color)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatShortDate}
          interval={labelEvery - 1}
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          axisLine={{ stroke: 'var(--border-color)' }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
          axisLine={false}
          tickLine={false}
          width={28}
        />
        <RTooltip content={<TrendTooltip toolNames={toolNames} />} cursor={{ stroke: 'var(--border-color)' }} />
        <Area
          type="monotone"
          dataKey="completed"
          stroke={CHART_COLORS.primary}
          strokeWidth={2}
          fill="url(#trendFill)"
          activeDot={{ r: 5 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Score Distribution — donut chart for Low/Medium/High. Donuts stay
// readable up to ~5 slices; 3 buckets is exactly the sweet spot.
function ScoreDistributionChart({ distribution }) {
  const data = [
    { name: 'Low', value: distribution.low, color: STATUS_MARK_COLORS.critical },
    { name: 'Medium', value: distribution.medium, color: STATUS_MARK_COLORS.serious },
    { name: 'High', value: distribution.high, color: STATUS_MARK_COLORS.good }
  ];
  const allZero = data.every(d => d.value === 0);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
      <div style={{ width: 160, height: 160, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius={48}
              outerRadius={72}
              paddingAngle={allZero ? 0 : 3}
              strokeWidth={0}
            >
              {data.map(d => <Cell key={d.name} fill={d.color} />)}
            </Pie>
            <RTooltip
              formatter={(value, name) => [`${value}%`, name]}
              contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="dimension-list" style={{ flex: 1, minWidth: 180 }}>
        {data.map(d => (
          <div className="dimension-row" key={d.name}>
            <span className="dimension-label">{d.name}</span>
            <div className="dimension-track">
              <div className="dimension-fill" style={{ width: `${d.value}%`, background: d.color }} />
            </div>
            <span className="dimension-value">{d.value}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Tool comparison — two small bar charts answering the doc's own questions
// verbatim: "which tool is used most" and "which tool has unusually
// low/high scores." Volume and score live on very different scales, so
// they're two charts rather than one dual-axis chart trying to do both.
function ToolComparisonCharts({ tools }) {
  if (!tools || tools.length === 0) return null;
  const volumeData = [...tools].sort((a, b) => b.totalTestTakers - a.totalTestTakers);
  const scoreData = [...tools].sort((a, b) => b.averageScorePercentage - a.averageScorePercentage);

  const scoreColor = (pct) => (pct >= 85 ? STATUS_MARK_COLORS.good : pct >= 60 ? STATUS_MARK_COLORS.serious : STATUS_MARK_COLORS.critical);

  return (
    <div className="split-grid">
      <div className="panel">
        <div className="panel-header">
          <h2>Volume by Tool</h2>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Which tool is used most</span>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(volumeData.length * 42, 120)}>
          <BarChart data={volumeData} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
              tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
              axisLine={false}
              tickLine={false}
            />
            <RTooltip
              formatter={(value) => [`${value} candidates`, 'Attempts']}
              contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
            />
            <Bar dataKey="totalTestTakers" fill={CHART_COLORS.primary} radius={[0, 4, 4, 0]} barSize={18}>
              <LabelList dataKey="totalTestTakers" position="right" style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Avg Score by Tool</h2>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Which tool scores unusually low/high</span>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(scoreData.length * 42, 120)}>
          <BarChart data={scoreData} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
            <XAxis type="number" domain={[0, 100]} hide />
            <YAxis
              type="category"
              dataKey="name"
              width={140}
              tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
              axisLine={false}
              tickLine={false}
            />
            <RTooltip
              formatter={(value) => [`${value}%`, 'Avg Score']}
              contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
            />
            <Bar dataKey="averageScorePercentage" radius={[0, 4, 4, 0]} barSize={18}>
              {scoreData.map(d => <Cell key={d.id} fill={scoreColor(d.averageScorePercentage)} />)}
              <LabelList dataKey="averageScorePercentage" position="right" formatter={(v) => `${v}%`} style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Fixed per-tool palette (index-based, stable regardless of sort order) —
// used by the Overview donut + leaderboard so a tool keeps the same color
// everywhere on that page. Draws straight from CATEGORICAL_PALETTE (8
// slots, fixed order) rather than a separate 5-color list, so a 6th tool
// (db6) gets its own slot instead of wrapping around and colliding with
// tool 1's color.
const TOOL_PALETTE = CATEGORICAL_PALETTE;

// One soft gradient per KPI card, each a subtle two-stop shade of its own
// categorical slot (not a separate hue list) — muted enough to sit on the
// neomorphic surface as a gentle accent chip rather than a loud block,
// while staying the same palette as the tool/chart colors below it. 9
// slots (some Analytics KPI rows run to index 8) by cycling back to slot
// 1 rather than introducing a 9th, off-palette hue.
const KPI_GRADIENTS = Array.from({ length: 9 }, (_, i) => {
  const hex = CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length];
  return `linear-gradient(135deg, ${hex} 0%, ${hex}cc 100%)`;
});

// Real weighted trend for Total Assessments only — it's a straight sum of
// per-tool volumes, and each tool already carries a genuine 7-day-vs-
// prior-7-day comparison (computeTrend on the backend), so combining them
// weighted by volume is an honest aggregate, not a fabricated number.
// Deliberately NOT reused for Average Score/Connections/Users — those
// have no time-series backing, so they get no trend badge at all rather
// than a made-up one.
function aggregateVolumeTrend(tools) {
  if (!tools || tools.length === 0) return null;
  let weightedSum = 0;
  let totalWeight = 0;
  tools.forEach(t => {
    if (t.trend && t.totalTestTakers > 0) {
      weightedSum += t.trend.changePercent * t.totalTestTakers;
      totalWeight += t.totalTestTakers;
    }
  });
  if (totalWeight === 0) return null;
  const changePercent = Math.round(weightedSum / totalWeight);
  return { direction: changePercent > 0 ? 'up' : changePercent < 0 ? 'down' : 'flat', changePercent };
}

// Colorful gradient KPI card. Trend badge only renders when `trend` is
// passed (i.e. real data exists) — no placeholder "0%" or invented arrows.
function KpiCard({ icon: Icon, gradient, label, value, sub, trend }) {
  return (
    <div className="kpi-card">
      <div className="kpi-card-icon" style={{ background: gradient }}><Icon size={18} /></div>
      <div className="kpi-card-label">{label}</div>
      <div className="kpi-card-value">{value}</div>
      <div className="kpi-card-footer">
        {trend && (
          <span className={`kpi-card-trend ${trend.direction}`}>
            {trend.direction === 'up' ? <TrendingUp size={12} /> : trend.direction === 'down' ? <TrendingDown size={12} /> : <Minus size={12} />}
            {Math.abs(trend.changePercent)}%
          </span>
        )}
        <span className="kpi-card-sub">{sub}</span>
      </div>
    </div>
  );
}

// Overview-only chart: composition, not comparison — "what share of all
// activity does each tool represent." Analytics' All-Tools view has no
// pie/donut at all, so this is a genuinely different question answered
// in a genuinely different chart type, not a re-skinned duplicate.
function ToolShareDonut({ tools }) {
  if (!tools || tools.length === 0) return null;
  const total = tools.reduce((sum, t) => sum + t.totalTestTakers, 0);
  const data = tools.map((t, i) => ({ id: t.id, name: t.name, value: t.totalTestTakers, color: TOOL_PALETTE[i % TOOL_PALETTE.length] }));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap' }}>
      <div style={{ width: 150, height: 150, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={44} outerRadius={70} paddingAngle={2} strokeWidth={0}>
              {data.map(d => <Cell key={d.id} fill={d.color} />)}
            </Pie>
            <RTooltip
              formatter={(value, name) => [`${value} (${total > 0 ? Math.round((value / total) * 100) : 0}%)`, name]}
              contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={{ flex: 1, minWidth: 170, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {data.map(d => (
          <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontSize: '0.82rem' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: d.color, flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{d.name}</span>
            <strong style={{ color: 'var(--text-primary)' }}>{total > 0 ? Math.round((d.value / total) * 100) : 0}%</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

// Overview-only chart: a compact ranked leaderboard combining volume AND
// score into one glanceable row per tool, instead of Analytics' two
// separate full-size bar-chart panels. Executive-summary style — rank,
// name, a mini inline bar, and both numbers in one line.
// Score Distribution by Tool — stacked horizontal bar chart. A new chart
// type on Overview (stacked composition per category), distinct from the
// donut (composition of one whole) and the trend area chart (time series).
// Uses the same status semantics as the score badges elsewhere in the app
// (low=critical, medium=serious, high=good) instead of an unrelated
// 3-hue set, so "low score" reads as the same color everywhere on the
// page — just the softer "serious" status step for medium instead of a
// full-saturation amber, so a wall of 5 stacked bars doesn't read as a
// wall of alarms.
const SCORE_BAND_COLORS = { low: STATUS_MARK_COLORS.critical, medium: STATUS_MARK_COLORS.serious, high: STATUS_MARK_COLORS.good };

// Compact inline stacked bar for table cells — same 3-color language as
// the Score Composition chart, just small enough to sit in a table row
// instead of three separate L/M/H badges eating horizontal space.
function MiniScoreBar({ distribution }) {
  return (
    <div
      className="mini-score-bar"
      title={`Low ${distribution.low}% · Medium ${distribution.medium}% · High ${distribution.high}%`}
    >
      <span style={{ width: `${distribution.low}%`, background: SCORE_BAND_COLORS.low }} />
      <span style={{ width: `${distribution.medium}%`, background: SCORE_BAND_COLORS.medium }} />
      <span style={{ width: `${distribution.high}%`, background: SCORE_BAND_COLORS.high }} />
    </div>
  );
}

function ScoreDistributionStackedChart({ tools }) {
  if (!tools || tools.length === 0) return null;
  const data = tools.map(t => ({
    name: t.name,
    Low: t.scoreDistribution.low,
    Medium: t.scoreDistribution.medium,
    High: t.scoreDistribution.high
  }));

  return (
    <div>
      <ResponsiveContainer width="100%" height={Math.max(data.length * 44, 140)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
          <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} unit="%" />
          <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 12, fill: 'var(--text-secondary)' }} axisLine={false} tickLine={false} />
          <RTooltip
            formatter={(value, name) => [`${value}%`, name]}
            contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
          />
          <Bar dataKey="Low" stackId="s" fill={SCORE_BAND_COLORS.low} barSize={16} radius={[4, 0, 0, 4]} />
          <Bar dataKey="Medium" stackId="s" fill={SCORE_BAND_COLORS.medium} barSize={16} />
          <Bar dataKey="High" stackId="s" fill={SCORE_BAND_COLORS.high} barSize={16} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: '1.25rem', justifyContent: 'center', marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: SCORE_BAND_COLORS.low, marginRight: '0.35rem' }} />Low</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: SCORE_BAND_COLORS.medium, marginRight: '0.35rem' }} />Medium</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: SCORE_BAND_COLORS.high, marginRight: '0.35rem' }} />High</span>
      </div>
    </div>
  );
}

// Average Score by Tool — radial gauge chart. A third, visually distinct
// chart form (circular progress rings) rounding out area/donut/stacked-bar.
function AvgScoreRadial({ tools }) {
  if (!tools || tools.length === 0) return null;
  const data = tools.map((t, i) => ({ name: t.name, value: t.averageScorePercentage, fill: TOOL_PALETTE[i % TOOL_PALETTE.length] }));

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '2rem', flexWrap: 'wrap' }}>
      <div style={{ width: 210, height: 210, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <RadialBarChart innerRadius="28%" outerRadius="100%" barSize={12} data={data} startAngle={90} endAngle={-270}>
            <RadialBar dataKey="value" background={{ fill: 'var(--bg-surface-hover)' }} cornerRadius={6} />
            <RTooltip
              formatter={(value, name, props) => [`${value}%`, props.payload.name]}
              contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
            />
          </RadialBarChart>
        </ResponsiveContainer>
      </div>
      <div style={{ flex: 1, minWidth: 170, display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {data.map(d => (
          <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', fontSize: '0.82rem' }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: d.fill, flexShrink: 0 }} />
            <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{d.name}</span>
            <strong style={{ color: 'var(--text-primary)' }}>{d.value}%</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS_COLOR = {
  healthy: CHART_COLORS.success,
  warning: CHART_COLORS.warning,
  critical: CHART_COLORS.danger,
  mock: CHART_COLORS.muted,
  unknown: CHART_COLORS.muted
};

// Status board — a status-page-style strip (colored dot + top accent bar
// per tile) instead of text-heavy cards, so "which of N tools is red" reads
// at a glance rather than requiring you to read every card.
function StatusGrid({ healthData }) {
  if (!healthData) return null;
  return (
    <div className="status-board">
      {Object.keys(healthData).map(dbId => {
        const h = healthData[dbId];
        const color = STATUS_COLOR[h.status] || CHART_COLORS.muted;
        return (
          <div className="status-tile" key={dbId} style={{ borderTopColor: color }}>
            <div className="status-tile-top">
              <span className="status-tile-dot" style={{ background: color, boxShadow: `0 0 0 4px ${color}22` }} />
              <span className="status-tile-name">{h.name}</span>
            </div>
            <div className="status-tile-meta">
              {h.calls > 0
                ? `${h.avgLatencyMs}ms avg${h.p95LatencyMs !== null ? ` · ${h.p95LatencyMs}ms p95` : ''} · ${h.errorRate}% errors`
                : 'No live queries yet'}
            </div>
            <div className="status-tile-footer">
              <span className={`health-status-pill ${h.status}`}>{h.status}</span>
              <AvailabilityPill availability={h.availability} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A small colored circle around a panel-header icon — the "icon badge"
// visual language carried through from the KPI cards, so headers don't
// revert to plain black icons once you scroll past the top row.
function PanelIconBadge({ icon: Icon, color }) {
  return (
    <span className="panel-icon-badge" style={{ background: color }}>
      <Icon size={13} />
    </span>
  );
}

const SEVERITY_COLOR = { critical: CHART_COLORS.danger, warning: CHART_COLORS.warning, info: CHART_COLORS.secondary, ok: CHART_COLORS.success };

// Overview-only alert row — a colored severity icon instead of relying
// only on background tint, matching the icon-badge language used
// everywhere else on this page. Analytics keeps its own plain alert-item
// style untouched.
function AlertRow({ alert }) {
  const color = SEVERITY_COLOR[alert.severity] || CHART_COLORS.muted;
  return (
    <div className="alert-row">
      <span className="alert-row-icon" style={{ background: color }}><AlertTriangle size={13} /></span>
      <div className="alert-row-body">
        {alert.tool && <strong>{alert.tool}</strong>}
        <span>{alert.message}</span>
      </div>
    </div>
  );
}

// Weekly PM Review — the same alert signals shown on Overview/Analytics,
// re-grouped server-side into a fixed weekly checklist (one row per topic
// instead of one row per tool) so a PM can scan status-by-topic in one pass.
const REVIEW_STATUS = {
  escalate: { label: 'Escalate', color: CHART_COLORS.danger, icon: AlertTriangle },
  attention: { label: 'Attention', color: CHART_COLORS.warning, icon: AlertTriangle },
  on_track: { label: 'On Track', color: CHART_COLORS.success, icon: CheckCircle2 }
};

const REVIEW_CATEGORY_ICON = {
  volume: TrendingUp,
  scores: Award,
  errors: AlertTriangle,
  payments: CreditCard,
  reports: FileCheck2,
  performance: Star,
  latency: HeartPulse,
  availability: Globe,
  dataSource: Database
};

// Tool scoring/ranking (Star/Growth/Maintain/Review) — a 4-column board,
// one card per tool, grouped by the tier the backend computed. Narrow and
// honest on purpose: performance = score + payment conversion only where
// a tool actually tracks payment, momentum = the real week-over-week
// volume trend. No revenue or satisfaction weighting — we don't have it.
const TIER_META = {
  star: { label: 'Star', color: CATEGORICAL_PALETTE[3], icon: Star, blurb: 'Strong performance, growing' },
  growth: { label: 'Growth', color: CHART_COLORS.secondary, icon: TrendingUp, blurb: 'Growing, performance building' },
  maintain: { label: 'Maintain', color: CHART_COLORS.primary, icon: CheckCircle2, blurb: 'Strong performance, steady' },
  review: { label: 'Review', color: CHART_COLORS.danger, icon: AlertTriangle, blurb: 'Needs a look' }
};

function ToolTierBoard({ tools, overviewData, onSelectTool }) {
  if (!tools || tools.length === 0) return null;
  const lastActivityById = {};
  (overviewData || []).forEach(t => { lastActivityById[t.id] = t.lastActivity; });

  return (
    <div className="tier-board">
      {Object.keys(TIER_META).map(tierKey => {
        const meta = TIER_META[tierKey];
        const Icon = meta.icon;
        const toolsInTier = tools.filter(t => t.tier === tierKey);
        return (
          <div className="tier-column" key={tierKey}>
            <div className="tier-column-header" style={{ borderTopColor: meta.color }}>
              <span className="panel-icon-badge" style={{ background: meta.color, marginRight: '0.4rem' }}>
                <Icon size={13} />
              </span>
              <div>
                <div className="tier-column-title">{meta.label}</div>
                <div className="tier-column-blurb">{meta.blurb}</div>
              </div>
            </div>
            {toolsInTier.length === 0 ? (
              <div className="tier-column-empty">No tools here</div>
            ) : (
              toolsInTier.map(tool => {
                const lastActivity = lastActivityById[tool.id];
                return (
                  <div className="tier-tool-card" key={tool.id} onClick={() => onSelectTool && onSelectTool(tool.id)}>
                    <div className="tier-tool-top">
                      <div className="tier-tool-name">{tool.name}</div>
                      <span className={`mode-badge ${tool.mode === 'live' ? 'live' : 'mock'}`} style={{ fontSize: '0.62rem', padding: '2px 6px' }}>
                        {tool.mode}
                      </span>
                    </div>
                    <div className="tier-tool-category">{tool.category}</div>
                    <div className="tier-tool-meta">
                      <span>{tool.usage} assessments</span>
                      {tool.performanceScore !== null && <span>{tool.performanceScore}/100</span>}
                      <TrendIndicator trend={tool.trend} />
                    </div>
                    {tool.hasPaymentData && (
                      <div className="tier-tool-payment">{tool.paymentRate}% payment conversion</div>
                    )}
                    <div className="tier-tool-reason">{tool.reason}</div>
                    <div className="tier-tool-activity">
                      {lastActivity ? `Last activity ${timeAgo(lastActivity)}` : 'No activity yet'}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}

// Tool Performance page — a sortable scorecard, one row per tool, built
// from /api/tool-performance. Deliberately reuses TIER_META, AvailabilityPill
// and health-status-pill from the Analytics panels above so a tier or a
// health status reads the same color/label everywhere in the app, not a
// second competing visual language. A column showing "—" means that
// tool's adapter doesn't track that signal (no payment column, no
// stable user id, etc.) — same "don't fake it" rule as everywhere else,
// not a zero.
const TOOL_PERF_COLUMNS = [
  { key: 'name', label: 'Tool', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'usage', label: 'Volume (7d trend)', sortable: true, align: 'right' },
  { key: 'avgScorePercentage', label: 'Avg Score', sortable: true, align: 'right' },
  { key: 'paymentRate', label: 'Payment Conv.', sortable: true, align: 'right' },
  { key: 'orgCount', label: 'Orgs', sortable: true, align: 'right' },
  { key: 'uniqueUsers', label: 'Users (repeat)', sortable: true, align: 'right' },
  { key: 'health', label: 'Health', sortable: false },
  { key: 'performanceScore', label: 'Composite', sortable: true, align: 'right' },
  { key: 'tier', label: 'Tier', sortable: true }
];

// Same thresholds as the App component's own getScoreClass(score, max) —
// this variant takes an already-computed percentage, for places (like
// this table) that only have avgScorePercentage, not a raw score/max pair.
function getScoreClassFromPct(pct) {
  if (pct >= 85) return 'high';
  if (pct >= 60) return 'medium';
  return 'low';
}

function sortToolPerformance(tools, sort) {
  const { key, dir } = sort;
  const mul = dir === 'asc' ? 1 : -1;
  return [...tools].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    // nulls (metric not tracked for this tool) always sort last, in either direction
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === 'string') return va.localeCompare(vb) * mul;
    return (va - vb) * mul;
  });
}

function ToolPerformanceTable({ tools, sort, onSort, onSelectTool }) {
  if (!tools) return <div className="trend-chart-empty">Loading tool performance...</div>;
  if (tools.length === 0) return <div className="trend-chart-empty">No tools configured.</div>;

  const sorted = sortToolPerformance(tools, sort);

  const handleHeaderClick = (col) => {
    if (!col.sortable) return;
    if (sort.key === col.key) {
      onSort({ key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' });
    } else {
      onSort({ key: col.key, dir: 'desc' });
    }
  };

  return (
    <div>
      <div className="table-container">
        <table className="custom-table tool-performance-table">
          <thead>
            <tr>
              {TOOL_PERF_COLUMNS.map(col => (
                <th
                  key={col.key}
                  style={{ textAlign: col.align || 'left', cursor: col.sortable ? 'pointer' : 'default' }}
                  onClick={() => handleHeaderClick(col)}
                >
                  {col.label}
                  {col.sortable && sort.key === col.key && (sort.dir === 'asc' ? ' ▲' : ' ▼')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(t => {
              const tierMeta = TIER_META[t.tier] || TIER_META.review;
              return (
                <tr key={t.id} onClick={() => onSelectTool(t.id)}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{t.name}</div>
                    <span className={`mode-badge ${t.mode === 'live' ? 'live' : 'mock'}`} style={{ fontSize: '0.65rem' }}>{t.mode}</span>
                  </td>
                  <td>{t.category}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem' }}>
                      {t.usage}
                      <TrendIndicator trend={t.trend} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <span className={`score-badge ${getScoreClassFromPct(t.avgScorePercentage)}`}>{t.avgScorePercentage}%</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{t.hasPaymentData ? `${t.paymentRate}%` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{t.orgCount !== null ? t.orgCount : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {t.uniqueUsers !== null ? `${t.uniqueUsers} (${t.avgAttemptsPerUser}x)` : '—'}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      <span className={`health-status-pill ${t.health.status}`}>{t.health.status}</span>
                      <AvailabilityPill availability={t.health.availability} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                    {t.performanceScore !== null ? `${t.performanceScore}/100` : '—'}
                  </td>
                  <td>
                    <span className="tier-pill-table" style={{ background: `${tierMeta.color}22`, color: tierMeta.color }} title={t.reason}>
                      {tierMeta.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="panel-note">
        Composite = score quality + payment conversion (only where a tool tracks payment), weighted against real
        week-over-week volume momentum — the same formula behind the Analytics tier board. Click a column to sort,
        click a row to open that tool's candidate list.
      </p>
    </div>
  );
}

// Tool Performance-only chart 1: composite score per tool, colored by the
// same tier a tool sits in on the table below — a different question than
// Overview's "Avg Score by Tool" (raw quality only), since the composite
// also folds in payment conversion and volume momentum.
function ToolCompositeScoreChart({ tools }) {
  const scored = [...tools].filter(t => t.performanceScore !== null).sort((a, b) => b.performanceScore - a.performanceScore);
  if (scored.length === 0) {
    return <div className="trend-chart-empty">No tool has a computed composite score yet.</div>;
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
        {Object.keys(TIER_META).map(tierKey => (
          <span key={tierKey} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: TIER_META[tierKey].color, display: 'inline-block' }} />
            {TIER_META[tierKey].label}
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={Math.max(scored.length * 42, 140)}>
        <BarChart data={scored} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }}>
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis
            type="category"
            dataKey="name"
            width={140}
            tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
            axisLine={false}
            tickLine={false}
          />
          <RTooltip
            formatter={(value, name, props) => [`${value}/100`, (TIER_META[props.payload.tier] || TIER_META.review).label]}
            contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
          />
          <Bar dataKey="performanceScore" radius={[0, 4, 4, 0]} barSize={18}>
            {scored.map(t => <Cell key={t.id} fill={(TIER_META[t.tier] || TIER_META.review).color} />)}
            <LabelList dataKey="performanceScore" position="right" style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Tool Performance-only chart 2: score quality next to payment conversion,
// per tool, both on the same 0-100% axis — answers "does a high-scoring
// tool actually convert to payment," which the table's separate columns
// don't make visually comparable at a glance. A tool without payment data
// simply gets no second bar, same "don't fake it" rule as its table column.
function ToolQualityVsPaymentChart({ tools }) {
  const data = tools.map(t => ({ id: t.id, name: t.name, avgScorePercentage: t.avgScorePercentage, paymentRate: t.hasPaymentData ? t.paymentRate : null }));
  const anyPayment = data.some(d => d.paymentRate !== null);
  return (
    <div>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: CATEGORICAL_PALETTE[0], display: 'inline-block' }} />
          Avg Score
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: CATEGORICAL_PALETTE[1], display: 'inline-block' }} />
          Payment Conversion
        </span>
      </div>
      <ResponsiveContainer width="100%" height={Math.max(data.length * 50, 160)}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 28, left: 0, bottom: 0 }} barGap={4}>
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis
            type="category"
            dataKey="name"
            width={140}
            tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
            axisLine={false}
            tickLine={false}
          />
          <RTooltip
            formatter={(value, name) => [`${value}%`, name === 'avgScorePercentage' ? 'Avg Score' : 'Payment Conversion']}
            contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
          />
          <Bar dataKey="avgScorePercentage" fill={CATEGORICAL_PALETTE[0]} radius={[0, 4, 4, 0]} barSize={12}>
            <LabelList dataKey="avgScorePercentage" position="right" formatter={(v) => `${v}%`} style={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
          </Bar>
          <Bar dataKey="paymentRate" fill={CATEGORICAL_PALETTE[1]} radius={[0, 4, 4, 0]} barSize={12}>
            <LabelList dataKey="paymentRate" position="right" formatter={(v) => (v === null || v === undefined ? '' : `${v}%`)} style={{ fontSize: 10, fill: 'var(--text-secondary)' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {!anyPayment && (
        <p className="panel-note">No tool in this set tracks payment conversion yet — bars show avg score only.</p>
      )}
    </div>
  );
}

// Org tool-usage breadth — how many of the 5 tools each org actually
// uses, matched by organization name across the separate per-tool org
// breakdowns (not a verified cross-system identity match).
function OrgBreadthChart({ data }) {
  if (!data || data.totalOrgs === 0) {
    return <div className="trend-chart-empty">No organization data available across live-connected tools yet.</div>;
  }
  const chartData = data.distribution.map(d => ({ ...d, label: `${d.toolCount} tool${d.toolCount === 1 ? '' : 's'}` }));
  const topOrgs = data.topOrgs || [];
  return (
    <div>
      <div className="org-breadth-headline">
        <strong>{data.lowUsagePercentage}%</strong> of {data.totalOrgs} organizations use only 1–2 tools
      </div>
      <ResponsiveContainer width="100%" height={Math.max(chartData.length * 38, 160)}>
        <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
          <XAxis type="number" allowDecimals={false} hide />
          <YAxis
            type="category"
            dataKey="label"
            width={70}
            tick={{ fontSize: 12, fill: 'var(--text-secondary)' }}
            axisLine={false}
            tickLine={false}
          />
          <RTooltip
            formatter={(value, name, props) => [`${value} orgs (${props.payload.percentage}%)`, 'Organizations']}
            contentStyle={{ background: 'var(--bg-surface)', border: '1px solid var(--border-color)', borderRadius: 8, fontSize: 12, boxShadow: 'var(--shadow-md)' }}
          />
          <Bar dataKey="orgCount" fill={CHART_COLORS.primary} radius={[0, 4, 4, 0]} barSize={16}>
            <LabelList dataKey="orgCount" position="right" style={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* The concrete "who" behind the bucket counts above — top orgs by
          adoption depth, so this panel answers "which orgs specifically
          need an upsell nudge" instead of just "how many." */}
      {topOrgs.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.6rem' }}>
            Top Organizations by Tool Adoption
          </div>
          <div className="org-list">
            {topOrgs.map(org => (
              <div className="org-list-row" key={org.organization}>
                <div className="org-list-name" title={org.organization}>{org.organization}</div>
                <span className={`tool-count-pill ${org.toolsUsed <= 2 ? 'low' : org.toolsUsed <= 4 ? 'mid' : 'high'}`}>
                  {org.toolsUsed} tool{org.toolsUsed === 1 ? '' : 's'}
                </span>
                <span className="org-list-meta">{org.totalAssessments} assessments</span>
                <span className="org-list-meta">
                  {org.lastActivity ? `Active ${timeAgo(org.lastActivity)}` : 'No activity date'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Acquisition (visitors, bounce rate, landing conversion) — sourced from
// GA4 per tool once GA4_SERVICE_ACCOUNT_KEY + GA4_PROPERTY_ID_<n> are
// configured on the backend. Nothing in any Supabase adapter can see a
// visitor who never completed an assessment, so until GA4 is wired up
// every row here is "not connected yet," not a fabricated number.
function AcquisitionPanel({ data }) {
  if (!data) return <div className="trend-chart-empty">Loading acquisition data...</div>;

  return (
    <div>
      <div className="org-breadth-headline">
        <strong>{data.configuredCount} / {data.totalTools}</strong> tools connected to GA4
      </div>
      {data.configuredCount === 0 && (
        <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 0.75rem' }}>
          No tool has GA4 wired up yet — none of the 6 candidate-facing sites run analytics today, so this
          can't show real traffic. Add the GA4 snippet to a site, set GA4_PROPERTY_ID_&lt;n&gt; and
          GA4_SERVICE_ACCOUNT_KEY on the backend, and its row goes live automatically.
        </p>
      )}
      <div className="table-container">
        <table className="custom-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>Visitors (7d)</th>
              <th>Bounce Rate</th>
              <th>Landing → Started</th>
            </tr>
          </thead>
          <tbody>
            {data.tools.map(t => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  <span className={`mode-badge ${t.mode === 'live' ? 'live' : 'mock'}`}>
                    {t.mode === 'live' ? 'Connected' : 'Not connected'}
                  </span>
                </td>
                <td>{t.mode === 'live' ? t.activeUsers : '—'}</td>
                <td>{t.bounceRate !== null ? `${t.bounceRate}%` : '—'}</td>
                <td>{t.landingConversionRate !== null ? `${t.landingConversionRate}%` : 'No assessment_started event yet'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WeeklyReviewRow({ row }) {
  const status = REVIEW_STATUS[row.status] || REVIEW_STATUS.on_track;
  const Icon = REVIEW_CATEGORY_ICON[row.category] || ListChecks;
  const StatusIcon = status.icon;
  return (
    <div className="weekly-review-row">
      <div className="weekly-review-row-main">
        <span className="panel-icon-badge" style={{ background: CHART_COLORS.muted }}>
          <Icon size={14} />
        </span>
        <div className="weekly-review-row-text">
          <div className="weekly-review-row-label">{row.label}</div>
          <div className="weekly-review-row-desc">{row.description}</div>
        </div>
        <span className="weekly-review-status-pill" style={{ background: `${status.color}22`, color: status.color }}>
          <StatusIcon size={13} /> {status.label}
        </span>
      </div>
      {row.items.length > 0 && (
        <div className="weekly-review-row-items">
          {row.items.map((item, i) => (
            <div className="weekly-review-item" key={i}>
              {item.tool && <strong>{item.tool}: </strong>}{item.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  // Authentication State
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [userEmail, setUserEmail] = useState(localStorage.getItem('userEmail') || '');
  // 'admin' or 'finance'. Finance is a Sales-only role: canViewSales also
  // doubles as "hide everything that isn't Sales" below, since finance is
  // the only role Sales is scoped to. This only gates what the sidebar
  // offers and what gets fetched — the backend enforces the same split on
  // its own (restrictFinanceToSalesOnly in server.js), and the role is
  // re-asked via /auth/me on load so a change takes effect without a
  // re-login.
  const [userRole, setUserRole] = useState(localStorage.getItem('userRole') || 'admin');
  const canViewSales = userRole === 'finance';
  const [authMode, setAuthMode] = useState('login'); // 'login' or 'register'
  const [authForm, setAuthForm] = useState({ email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Navigation State: 'overview', 'analytics', 'db1'-'db5', 'settings'
  const [currentView, setCurrentView] = useState('overview');
  const [dbStatuses, setDbStatuses] = useState(null);
  const [overviewData, setOverviewData] = useState([]);
  const [summaryData, setSummaryData] = useState(null);

  // Analytics page: 'all' or a specific dbId to drill into
  const [analyticsTool, setAnalyticsTool] = useState('all');
  // Category filter — narrows the tool dropdown to one category
  // (e.g. AI Assessment, Psychometric) instead of listing every tool as
  // its own tab. 'all' shows every tool in the dropdown, ungrouped.
  const [analyticsCategory, setAnalyticsCategory] = useState('all');

  // Sidebar category accordion — which category (if any) is expanded to
  // show its tool names. Purely a sidebar UI toggle, unrelated to Analytics.
  const [expandedSidebarCategory, setExpandedSidebarCategory] = useState(null);

  // Usage trend, live activity, alerts, system health, reports — all
  // live on the Analytics page now
  const [trendRange, setTrendRange] = useState('7d');
  // Custom trend date range — default to the last 7 days so the picker
  // isn't blank the moment "Custom" is clicked.
  const [customStartDate, setCustomStartDate] = useState(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [customEndDate, setCustomEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [trendSeries, setTrendSeries] = useState([]);
  const [trendLoading, setTrendLoading] = useState(false);
  const [activityData, setActivityData] = useState([]);
  const [alertsData, setAlertsData] = useState([]);
  const [healthData, setHealthData] = useState(null);
  const [reportsSummary, setReportsSummary] = useState(null);
  const [entitySummary, setEntitySummary] = useState(null);
  const [toolScoring, setToolScoring] = useState(null);
  const [orgBreadth, setOrgBreadth] = useState(null);
  const [acquisition, setAcquisition] = useState(null);
  const [toolPerformance, setToolPerformance] = useState(null);
  const [toolPerfSort, setToolPerfSort] = useState({ key: 'performanceScore', dir: 'desc' });
  const [weeklyReview, setWeeklyReview] = useState(null);
  const [weeklyReviewLoading, setWeeklyReviewLoading] = useState(false);

  // Assessment Details State
  const [candidates, setCandidates] = useState([]);
  const [assessmentName, setAssessmentName] = useState('');
  const [assessmentMode, setAssessmentMode] = useState('mock');
  const [searchQuery, setSearchQuery] = useState('');

  // Organization / User / Dimension monitoring for the selected tool
  const [orgBreakdown, setOrgBreakdown] = useState({ supported: false, organizations: [] });
  const [userBreakdown, setUserBreakdown] = useState({ supported: false, totalUniqueUsers: 0, averageAttemptsPerUser: 0, users: [] });
  const [dimensionData, setDimensionData] = useState({ supported: false, dimensions: [] });
  const [paymentData, setPaymentData] = useState({ supported: false });

  // Selected Candidate Drawer State
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [candidateDetails, setCandidateDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  // Settings State
  const [configForms, setConfigForms] = useState({
    db1: { url: '', key: '' },
    db2: { url: '', key: '' },
    db3: { url: '', key: '' },
    db4: { url: '', key: '' },
    db5: { url: '', key: '' },
    db6: { url: '', key: '' }
  });

  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState(false);
  const [saveMessages, setSaveMessages] = useState({});

  // Auth Handlers
  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userEmail');
    localStorage.removeItem('userRole');
    setToken('');
    setUserEmail('');
    setUserRole('admin');
    setCurrentView('overview');
  };

  // Helper fetch function that automatically injects auth token
  const authFetch = async (url, options = {}) => {
    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };

    // FormData sets its own multipart boundary — never force JSON on it.
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      const res = await fetch(url, { ...options, headers });
      // A FORBIDDEN_ROLE 403 means "your role can't open this", not "your
      // session is bad" — leave the user logged in and let the caller
      // show the error.
      const roleDenied = res.status === 403 && (await res.clone().json().catch(() => ({}))).code === 'FORBIDDEN_ROLE';
      if (res.status === 401 || (res.status === 403 && !roleDenied)) {
        handleLogout();
        throw new Error('Session expired or unauthorized. Please log in again.');
      }
      return res;
    } catch (err) {
      if (err.message.includes('Session expired')) {
        throw err;
      }
      console.error('Fetch error:', err);
      throw err;
    }
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthSuccess('');

    if (!authForm.email || !authForm.password) {
      setAuthError('Email and password are required.');
      return;
    }

    if (authMode === 'register' && authForm.password.length < 6) {
      setAuthError('Password must be at least 6 characters.');
      return;
    }

    setAuthLoading(true);
    try {
      const url = `${API_BASE}/auth/${authMode}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authForm)
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Authentication request failed.');
      }

      if (authMode === 'register') {
        setAuthSuccess('Registration successful! You can now log in.');
        setAuthMode('login');
        setAuthForm(prev => ({ ...prev, password: '' }));
      } else {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userEmail', data.email);
        localStorage.setItem('userRole', data.role || 'admin');
        setToken(data.token);
        setUserEmail(data.email);
        setUserRole(data.role || 'admin');
        setAuthForm({ email: '', password: '' });
      }
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // 1. Initial Load: Fetch API Status and Overview (used by sidebar nav
  // and the Overview landing page). Finance can't reach any of this on
  // the backend (restrictFinanceToSalesOnly) and never sees it in the
  // sidebar, so skip the calls entirely rather than surface them as a
  // backend-error banner.
  const loadInitialData = async () => {
    if (!token || canViewSales) return;
    setLoading(true);
    setBackendError(false);
    try {
      const statusRes = await authFetch(`${API_BASE}/status`);
      if (!statusRes.ok) throw new Error('API server error');
      const statusData = await statusRes.json();
      setDbStatuses(statusData);

      const overviewRes = await authFetch(`${API_BASE}/overview`);
      const overviewData = await overviewRes.json();
      setOverviewData(overviewData);

      const summaryRes = await authFetch(`${API_BASE}/overview/summary`);
      const summaryData = await summaryRes.json();
      setSummaryData(summaryData);
    } catch (err) {
      console.error('Error connecting to backend:', err);
      if (!err.message.includes('Session expired')) {
        setBackendError(true);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token && !canViewSales) {
      loadInitialData();
    }
  }, [token, canViewSales]);

  // Re-check the role with the backend rather than trusting what login
  // stored in localStorage — picks up a role change made since then.
  useEffect(() => {
    if (!token) return;
    authFetch(`${API_BASE}/auth/me`)
      .then(res => (res.ok ? res.json() : null))
      .then(me => {
        if (!me) return;
        localStorage.setItem('userRole', me.role);
        setUserRole(me.role);
      })
      .catch(() => {});
  }, [token]);

  // Finance is Sales-only: bounce it onto a Sales view if it somehow isn't
  // on one (first login, a stale view from before a demotion/promotion).
  // Everyone else is bounced the other way, off a Sales view they no
  // longer have (demoted away from finance).
  useEffect(() => {
    const onSalesView = currentView === 'leads' || currentView === 'leads-dashboard';
    if (canViewSales && !onSalesView) {
      setCurrentView('leads-dashboard');
    } else if (!canViewSales && onSalesView) {
      setCurrentView('overview');
    }
  }, [canViewSales, currentView]);

  // Analytics — cross-tool signals (health, alerts, report monitoring)
  // fetched whenever Analytics OR the Overview dashboard is open — Overview
  // shows a condensed version of the same charts, so it needs the same data.
  useEffect(() => {
    if (!token || (currentView !== 'analytics' && currentView !== 'overview')) return;
    const fetchAnalyticsCrossTool = async () => {
      try {
        const [healthRes, alertsRes, reportsRes, entitiesRes] = await Promise.all([
          authFetch(`${API_BASE}/health`),
          authFetch(`${API_BASE}/alerts`),
          authFetch(`${API_BASE}/reports/summary`),
          authFetch(`${API_BASE}/overview/entities`)
        ]);
        setHealthData(await healthRes.json());
        setAlertsData((await alertsRes.json()).alerts || []);
        setReportsSummary(await reportsRes.json());
        setEntitySummary(await entitiesRes.json());
      } catch (err) {
        console.error('Error fetching analytics cross-tool data:', err);
      }
    };
    fetchAnalyticsCrossTool();
  }, [token, currentView]);

  // Tool scoring (Star/Growth/Maintain/Review) + org tool-usage breadth —
  // only rendered on the Analytics all-tools view, so only fetched there.
  useEffect(() => {
    if (!token || currentView !== 'analytics') return;
    const fetchToolScoringAndBreadth = async () => {
      try {
        const [scoringRes, breadthRes, acquisitionRes] = await Promise.all([
          authFetch(`${API_BASE}/tool-scoring`),
          authFetch(`${API_BASE}/org-breadth`),
          authFetch(`${API_BASE}/acquisition`)
        ]);
        setToolScoring((await scoringRes.json()).tools || []);
        setOrgBreadth(await breadthRes.json());
        setAcquisition(await acquisitionRes.json());
      } catch (err) {
        console.error('Error fetching tool scoring / org breadth / acquisition:', err);
      }
    };
    fetchToolScoringAndBreadth();
  }, [token, currentView]);

  // Tool Performance — the dedicated per-tool scorecard page (its own
  // sidebar entry, not just the tier board embedded in Analytics). One
  // merged backend call, only fetched when this view is open.
  useEffect(() => {
    if (!token || currentView !== 'tool-performance') return;
    const fetchToolPerformance = async () => {
      try {
        const res = await authFetch(`${API_BASE}/tool-performance`);
        setToolPerformance((await res.json()).tools || []);
      } catch (err) {
        console.error('Error fetching tool performance:', err);
      }
    };
    fetchToolPerformance();
  }, [token, currentView]);

  // Weekly PM Review — same alert signals as Analytics/Overview, just
  // re-grouped server-side into a fixed weekly checklist. Only fetched
  // when that view is open; also callable directly from its Refresh button.
  const loadWeeklyReview = async () => {
    setWeeklyReviewLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/weekly-review`);
      setWeeklyReview(await res.json());
    } catch (err) {
      console.error('Error fetching weekly review:', err);
    } finally {
      setWeeklyReviewLoading(false);
    }
  };

  useEffect(() => {
    if (!token || currentView !== 'weekly-review') return;
    loadWeeklyReview();
  }, [token, currentView]);

  // Usage trend — scoped to the selected tool on Analytics, always
  // company-wide on the Overview dashboard. "Custom" sends explicit
  // startDate/endDate instead of a range key; waits for both dates to be
  // picked before fetching.
  useEffect(() => {
    if (!token || (currentView !== 'analytics' && currentView !== 'overview')) return;
    if (trendRange === 'custom' && (!customStartDate || !customEndDate)) return;
    const fetchTrend = async () => {
      setTrendLoading(true);
      try {
        const scopedTool = currentView === 'analytics' ? analyticsTool : 'all';
        const dbParam = scopedTool !== 'all' ? `&dbId=${scopedTool}` : '';
        const rangeParam = trendRange === 'custom'
          ? `startDate=${customStartDate}&endDate=${customEndDate}`
          : `range=${trendRange}`;
        const res = await authFetch(`${API_BASE}/overview/trend?${rangeParam}${dbParam}`);
        const data = await res.json();
        setTrendSeries(data.series || []);
      } catch (err) {
        console.error('Error fetching trend:', err);
      } finally {
        setTrendLoading(false);
      }
    };
    fetchTrend();
  }, [token, currentView, trendRange, analyticsTool, customStartDate, customEndDate]);

  // Analytics — live activity feed, scoped to the selected tool.
  useEffect(() => {
    if (!token || currentView !== 'analytics') return;
    const fetchActivity = async () => {
      try {
        const dbParam = analyticsTool !== 'all' ? `&dbId=${analyticsTool}` : '';
        const res = await authFetch(`${API_BASE}/activity?limit=15${dbParam}`);
        const data = await res.json();
        setActivityData(data.events || []);
      } catch (err) {
        console.error('Error fetching activity:', err);
      }
    };
    fetchActivity();
  }, [token, currentView, analyticsTool]);

  // Analytics — dimensions / organization / user / payment breakdowns
  // for the selected tool (only meaningful once a specific tool is picked).
  useEffect(() => {
    if (!token || currentView !== 'analytics') return;
    if (analyticsTool === 'all') {
      setOrgBreakdown({ supported: false, organizations: [] });
      setUserBreakdown({ supported: false, totalUniqueUsers: 0, averageAttemptsPerUser: 0, users: [] });
      setDimensionData({ supported: false, dimensions: [] });
      setPaymentData({ supported: false });
      return;
    }
    const fetchBreakdowns = async () => {
      try {
        const [orgRes, userRes, dimRes, paymentRes] = await Promise.all([
          authFetch(`${API_BASE}/assessments/${analyticsTool}/organizations`),
          authFetch(`${API_BASE}/assessments/${analyticsTool}/users`),
          authFetch(`${API_BASE}/assessments/${analyticsTool}/dimensions`),
          authFetch(`${API_BASE}/assessments/${analyticsTool}/payments`)
        ]);
        setOrgBreakdown(await orgRes.json());
        setUserBreakdown(await userRes.json());
        setDimensionData(await dimRes.json());
        setPaymentData(await paymentRes.json());
      } catch (err) {
        console.error('Error fetching org/user/dimension/payment breakdowns:', err);
      }
    };
    fetchBreakdowns();
  }, [token, currentView, analyticsTool]);

  // 2. Fetch candidates when switching to a tool's candidate-management view
  useEffect(() => {
    if (token && currentView.startsWith('db')) {
      const fetchCandidates = async () => {
        setLoading(true);
        try {
          const res = await authFetch(`${API_BASE}/assessments/${currentView}/candidates`);
          const data = await res.json();
          setCandidates(data.candidates || []);
          setAssessmentName(data.assessmentName || 'Assessment Tool');
          setAssessmentMode(data.mode || 'mock');
        } catch (err) {
          console.error(err);
        } finally {
          setLoading(false);
        }
      };
      fetchCandidates();
      setSelectedCandidate(null);
      setCandidateDetails(null);
      setSearchQuery('');
    }
  }, [currentView, token]);

  // 3. Fetch details for Candidate Drawer
  const handleSelectCandidate = async (candidate) => {
    setSelectedCandidate(candidate);
    setDetailsLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/assessments/${currentView}/candidates/${candidate.id}`);
      const data = await res.json();
      setCandidateDetails(data);
    } catch (err) {
      console.error(err);
    } finally {
      setDetailsLoading(false);
    }
  };

  // 4. Download PDF report
  const downloadPdf = async (candidateId, name) => {
    setPdfLoading(true);
    try {
      const response = await authFetch(`${API_BASE}/assessments/${currentView}/candidates/${candidateId}/pdf`);
      if (!response.ok) throw new Error('PDF Generation Failed');

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name.replace(/\s+/g, '_')}_Result.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Error generating PDF: ${err.message}`);
    } finally {
      setPdfLoading(false);
    }
  };

  // 5. Update individual Supabase configuration
  const handleConfigChange = (dbId, field, value) => {
    setConfigForms(prev => ({
      ...prev,
      [dbId]: {
        ...prev[dbId],
        [field]: value
      }
    }));
  };

  const saveConfig = async (dbId) => {
    const { url, key } = configForms[dbId];
    if (!url || !key) {
      setSaveMessages(prev => ({ ...prev, [dbId]: { type: 'error', text: 'URL and Key are required.' } }));
      return;
    }

    try {
      const res = await authFetch(`${API_BASE}/config`, {
        method: 'POST',
        body: JSON.stringify({ dbId, url, key })
      });
      const data = await res.json();
      if (data.success) {
        setSaveMessages(prev => ({ ...prev, [dbId]: { type: 'success', text: 'Connected successfully!' } }));
        // Refresh statuses
        loadInitialData();
      } else {
        setSaveMessages(prev => ({ ...prev, [dbId]: { type: 'error', text: data.error || 'Failed' } }));
      }
    } catch (err) {
      setSaveMessages(prev => ({ ...prev, [dbId]: { type: 'error', text: err.message || 'Connection failed' } }));
    }
  };

  const resetAllConfigs = async () => {
    if (!confirm('Are you sure you want to reset all connections?')) return;
    try {
      const res = await authFetch(`${API_BASE}/config/reset`, { method: 'POST' });
      await res.json();
      // Clear forms
      setConfigForms({
        db1: { url: '', key: '' },
        db2: { url: '', key: '' },
        db3: { url: '', key: '' },
        db4: { url: '', key: '' },
        db5: { url: '', key: '' },
        db6: { url: '', key: '' }
      });
      setSaveMessages({});
      loadInitialData();
    } catch (err) {
      alert(err.message || 'Reset failed');
    }
  };

  // Filters
  const filteredCandidates = candidates.filter(c =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // dbId -> display name, for the trend chart's per-tool tooltip breakdown
  const toolNames = Object.fromEntries(overviewData.map(t => [t.id, t.name]));

  // Helper score range styling class
  const getScoreClass = (score, max) => {
    const pct = (score / max) * 100;
    if (pct >= 85) return 'high';
    if (pct >= 60) return 'medium';
    return 'low';
  };

  if (backendError) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '1.5rem', padding: '2rem', textAlign: 'center' }}>
        <ShieldAlert size={64} color="var(--accent-danger)" />
        <h1 style={{ fontSize: '2rem', fontWeight: '800' }}>Backend Server Offline</h1>
        <p style={{ color: 'var(--text-muted)', maxWidth: '500px' }}>
          We could not connect to the Express server running on port 5000. Please start the backend server using `npm start` in the `backend` folder first.
        </p>
        <button className="btn btn-primary" onClick={loadInitialData}>
          <RefreshCw size={18} /> Retry Connection
        </button>
      </div>
    );
  }

  // Auth Screen check
  if (!token) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-header">
            <div className="auth-logo">
              <LayoutDashboard size={28} />
            </div>
            <h1 className="auth-title">Infopace Admin Panel</h1>
            <p className="auth-subtitle">
              {authMode === 'login' ? 'Log in to your admin account' : 'Create an admin account'}
            </p>
          </div>

          <div className="auth-body">
            {authError && (
              <div className="alert-auth">
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{authError}</span>
              </div>
            )}

            {authSuccess && (
              <div className="alert-auth-success">
                <Check size={16} style={{ flexShrink: 0, marginTop: '2px' }} />
                <span>{authSuccess}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit}>
              <div className="form-group">
                <label className="form-label">Email Address</label>
                <div className="form-control-wrap">
                  <Mail size={16} className="form-control-icon" />
                  <input
                    type="email"
                    className="form-control"
                    placeholder="admin@example.com"
                    value={authForm.email}
                    onChange={(e) => setAuthForm(prev => ({ ...prev, email: e.target.value }))}
                    required
                  />
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Password</label>
                <div className="form-control-wrap">
                  <ShieldAlert size={16} className="form-control-icon" />
                  <input
                    type="password"
                    className="form-control"
                    placeholder="••••••••"
                    value={authForm.password}
                    onChange={(e) => setAuthForm(prev => ({ ...prev, password: e.target.value }))}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary auth-btn"
                disabled={authLoading}
              >
                {authLoading ? (
                  <RefreshCw className="animate-spin" size={18} style={{ animation: 'spin 1s linear infinite' }} />
                ) : (
                  authMode === 'login' ? 'Log In' : 'Register Account'
                )}
              </button>
            </form>

            <div className="auth-footer">
              {authMode === 'login' ? (
                <span>
                  Don't have an account?{' '}
                  <span className="auth-toggle-link" onClick={() => { setAuthMode('register'); setAuthError(''); setAuthSuccess(''); }}>
                    Register
                  </span>
                </span>
              ) : (
                <span>
                  Already have an account?{' '}
                  <span className="auth-toggle-link" onClick={() => { setAuthMode('login'); setAuthError(''); setAuthSuccess(''); }}>
                    Log In
                  </span>
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      {/* SIDEBAR NAVIGATION */}
      <aside className="sidebar">
        <div className="logo-container" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '2.5rem' }}>
          <img src="/infopace.png" alt="Infopace Logo" style={{ width: '40px', height: '40px', borderRadius: '8px', objectFit: 'contain', backgroundColor: 'white', padding: '3px' }} />
          <span className="logo-text" style={{ fontSize: '1.15rem' }}>Admin Panel</span>
        </div>

        {/* Finance is Sales-only (see canViewSales above) — none of this,
            nor Social, nor Tool Categories below, is reachable on the
            backend for that role, so there's nothing for it to click into
            here either. */}
        {!canViewSales && (
        <div className="menu-section">
          <div className="menu-title">Main Dashboard</div>
          <ul className="menu-list">
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'overview' ? 'active' : ''}`}
                onClick={() => setCurrentView('overview')}
              >
                <LayoutDashboard size={18} /> Overview
              </div>
            </li>
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'analytics' ? 'active' : ''}`}
                onClick={() => setCurrentView('analytics')}
              >
                <BarChart3 size={18} /> Analytics
              </div>
            </li>
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'tool-performance' ? 'active' : ''}`}
                onClick={() => setCurrentView('tool-performance')}
              >
                <Star size={18} /> Tool Performance
              </div>
            </li>
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'weekly-review' ? 'active' : ''}`}
                onClick={() => setCurrentView('weekly-review')}
              >
                <ListChecks size={18} /> Weekly Review
              </div>
            </li>
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'settings' ? 'active' : ''}`}
                onClick={() => setCurrentView('settings')}
              >
                <Settings size={18} /> Supabase Settings
              </div>
            </li>
          </ul>
        </div>
        )}

        {!canViewSales && <SocialNav currentView={currentView} setCurrentView={setCurrentView} />}

        {canViewSales && (
        <div className="menu-section">
          <div className="menu-title">Sales</div>
          <ul className="menu-list">
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'leads-dashboard' ? 'active' : ''}`}
                onClick={() => setCurrentView('leads-dashboard')}
              >
                <LayoutGrid size={18} /> Dashboard
              </div>
            </li>
            <li className="menu-item">
              <div
                className={`menu-link ${currentView === 'leads' ? 'active' : ''}`}
                onClick={() => setCurrentView('leads')}
              >
                <Target size={18} /> All Leads
              </div>
            </li>
          </ul>
        </div>
        )}

        {/* Category accordion — collapsed by default, showing just the
            category name. Clicking a category toggles it open/closed in
            place (pure sidebar UI, no navigation); clicking a tool name
            once expanded navigates to that tool's candidate-management
            view, same as before. Categories are derived from each
            adapter's metadata.category, so a new one like "Psychometric"
            appears here automatically the moment a tool declares it. */}
        {!canViewSales && (
        <div className="menu-section">
          <div className="menu-title">Tool Categories</div>
          <ul className="menu-list">
            {Array.from(new Set(overviewData.map(t => t.category || 'Uncategorized'))).map(cat => {
              const isOpen = expandedSidebarCategory === cat;
              const toolsInCategory = overviewData.filter(t => (t.category || 'Uncategorized') === cat);
              return (
                <li className="menu-item" key={cat}>
                  <div
                    className="menu-link"
                    onClick={() => setExpandedSidebarCategory(isOpen ? null : cat)}
                  >
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cat}
                    </span>
                  </div>
                  {isOpen && (
                    <ul className="menu-list menu-list-nested">
                      {toolsInCategory.map(item => (
                        <li className="menu-item" key={item.id}>
                          <div
                            className={`menu-link menu-link-nested ${currentView === item.id ? 'active' : ''}`}
                            onClick={() => setCurrentView(item.id)}
                          >
                            <Database size={16} />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {item.name}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        )}

        {/* User profile & Logout */}
        <div className="sidebar-user-profile">
          <div className="user-profile-details">
            <div className="user-profile-avatar">
              {userEmail ? userEmail[0].toUpperCase() : 'A'}
            </div>
            <div className="user-profile-email" title={userEmail}>
              {userEmail || 'Admin User'}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
            Logout
          </button>
        </div>
      </aside>

      {/* MAIN VIEW */}
      <main className="main-content">

        {/* VIEW: OVERVIEW — the 30-second glance: condensed KPIs + charts,
            reusing the same components as Analytics. Full depth (12-column
            table, live activity feed, org/user/dimension breakdowns) stays
            on Analytics only — this page is summary + click-through. */}
        {currentView === 'overview' && (
          <div>
            <div className="header-container">
              <div className="title-area">
                <h1>Overview Portal</h1>
                <p>Company-wide snapshot across all 5 tools — see Analytics for full monitoring.</p>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button className="btn btn-secondary btn-sm" onClick={loadInitialData}>
                  <RefreshCw size={14} /> Refresh Data
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => setCurrentView('analytics')}>
                  <BarChart3 size={14} /> Open Analytics
                </button>
              </div>
            </div>

            {loading ? (
              <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                <RefreshCw className="animate-spin" size={32} style={{ margin: '0 auto 1rem auto', animation: 'spin 1s linear infinite' }} />
                Loading aggregated stats...
              </div>
            ) : (
              <>
                {/* Top KPI strip — colorful gradient cards, 5 most important
                    numbers. Trend badge only on Total Assessments, the one
                    metric with real day-over-day data behind it. */}
                {summaryData && (
                  <div className="kpi-grid" style={{ marginBottom: '1.5rem' }}>
                    <KpiCard
                      icon={BarChart3}
                      gradient={KPI_GRADIENTS[0]}
                      label="Total Assessments"
                      value={summaryData.totalAssessments}
                      sub="Across all tools"
                      trend={aggregateVolumeTrend(overviewData)}
                    />
                    <KpiCard
                      icon={Award}
                      gradient={KPI_GRADIENTS[1]}
                      label="Average Score"
                      value={`${summaryData.averageScorePercentage}%`}
                      sub="Weighted across tools"
                    />
                    <KpiCard
                      icon={Database}
                      gradient={KPI_GRADIENTS[2]}
                      label="Live Connections"
                      value={`${summaryData.liveToolsCount} / ${summaryData.totalTools}`}
                      sub={`${summaryData.mockToolsCount} using mock data`}
                    />
                    <KpiCard
                      icon={FileCheck2}
                      gradient={KPI_GRADIENTS[3]}
                      label="Reports Generated"
                      value={reportsSummary ? reportsSummary.totalGenerated : '—'}
                      sub={reportsSummary ? `${reportsSummary.successRate}% success rate` : 'Loading...'}
                    />
                    <KpiCard
                      icon={User}
                      gradient={KPI_GRADIENTS[4]}
                      label="Active Users (30d)"
                      value={entitySummary ? entitySummary.activeUsers30d : '—'}
                      sub={entitySummary ? `${entitySummary.totalUsers} unique all-time` : 'Loading...'}
                    />
                  </div>
                )}

                {/* Trend + tool-share donut, side by side — two different
                    "big picture" questions (direction over time, and
                    composition right now), not stacked full-width like
                    Analytics does for the trend alone. */}
                <div className="split-grid">
                  <div className="panel">
                    <div className="panel-header">
                      <h2><PanelIconBadge icon={TrendingUp} color={CHART_COLORS.primary} />Assessment Activity Trend</h2>
                      <TrendRangeSelector
                        trendRange={trendRange}
                        setTrendRange={setTrendRange}
                        customStartDate={customStartDate}
                        setCustomStartDate={setCustomStartDate}
                        customEndDate={customEndDate}
                        setCustomEndDate={setCustomEndDate}
                      />
                    </div>
                    {trendLoading ? (
                      <div className="trend-chart-empty">Loading trend...</div>
                    ) : (
                      <TrendChart series={trendSeries} toolNames={toolNames} />
                    )}
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2><PanelIconBadge icon={Database} color={CHART_COLORS.secondary} />Share of Assessments</h2>
                    </div>
                    <ToolShareDonut tools={overviewData} />
                  </div>
                </div>

                {/* Score composition (stacked bar) + Avg Score (radial gauge) —
                    two more chart forms, side by side */}
                <div className="split-grid">
                  <div className="panel">
                    <div className="panel-header">
                      <h2><PanelIconBadge icon={BarChart3} color={CHART_COLORS.warning} />Score Composition by Tool</h2>
                    </div>
                    <ScoreDistributionStackedChart tools={overviewData} />
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2><PanelIconBadge icon={Award} color={CHART_COLORS.danger} />Average Score</h2>
                    </div>
                    <AvgScoreRadial tools={overviewData} />
                  </div>
                </div>

                {/* Attention Required */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={AlertTriangle} color={CHART_COLORS.warning} />Attention Required</h2>
                    <button className="btn btn-secondary btn-sm" onClick={() => { setAnalyticsTool('all'); setCurrentView('analytics'); }}>
                      View All
                    </button>
                  </div>
                  <div className="alerts-list">
                    {alertsData.slice(0, 4).map((alert, idx) => <AlertRow alert={alert} key={idx} />)}
                    {alertsData.length === 0 && <div className="trend-chart-empty">Loading alerts...</div>}
                  </div>
                </div>

                {/* System Health — same full status-tile grid as Analytics */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={HeartPulse} color={CHART_COLORS.success} />System Health</h2>
                    {reportsSummary && (
                      <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                        <span><FileCheck2 size={13} style={{ verticalAlign: '-2px' }} /> {reportsSummary.totalGenerated} generated / downloaded</span>
                        <span>{reportsSummary.totalFailed} failed</span>
                        <span>0 pending</span>
                        <span>{reportsSummary.totalRegenerated} regenerated</span>
                        <span>{reportsSummary.successRate}% success rate</span>
                        {reportsSummary.avgGenerationTimeMs !== null && (
                          <span>{reportsSummary.avgGenerationTimeMs}ms avg generation time</span>
                        )}
                        <span className={`health-status-pill ${reportsSummary.successRate >= 95 ? 'healthy' : reportsSummary.successRate >= 80 ? 'warning' : 'critical'}`}>
                          Report Service: {reportsSummary.successRate >= 95 ? 'Healthy' : reportsSummary.successRate >= 80 ? 'Degraded' : 'Critical'}
                        </span>
                      </div>
                    )}
                  </div>
                  <StatusGrid healthData={healthData} />
                </div>

                {/* Per-tool cards — click through to manage candidates */}
                <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem' }}>Tools</h2>
                <div className="stats-grid">
                  {overviewData.map((item, idx) => (
                    <div
                      className={`stat-card db${idx + 1}`}
                      key={item.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setCurrentView(item.id)}
                    >
                      <div>
                        <span className="stat-label">{item.name}</span>
                        <div className="stat-value">{item.totalTestTakers}</div>
                        <span className="stat-desc">Candidates — click to manage</span>
                      </div>
                      <div className="stat-icon" style={{ background: TOOL_PALETTE[idx % TOOL_PALETTE.length] }}>
                        <Database size={17} color="#ffffff" />
                      </div>
                      <div style={{ position: 'absolute', bottom: 10, right: 15 }}>
                        <span className={`score-badge ${getScoreClass(item.averageScorePercentage, 100)}`} style={{ fontSize: '0.7rem' }}>
                          Avg: {item.averageScorePercentage}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* VIEW: ANALYTICS — full monitoring dashboard, doc sections 1-15.
            "All Tools" tab = master dashboard; a specific tool tab = the
            same framework dynamically populated for that one tool. */}
        {currentView === 'analytics' && (
          <div>
            <div className="header-container">
              <div className="title-area">
                <h1>Analytics</h1>
                <p>Usage, performance, and health monitoring across every assessment tool.</p>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <div className="range-tabs" style={{ flexWrap: 'wrap' }}>
                  <button
                    className={`range-tab ${analyticsTool === 'all' ? 'active' : ''}`}
                    onClick={() => { setAnalyticsCategory('all'); setAnalyticsTool('all'); }}
                  >
                    All Tools
                  </button>
                  {Array.from(new Set(overviewData.map(t => t.category || 'Uncategorized'))).map(cat => (
                    <button
                      key={cat}
                      className={`range-tab ${analyticsCategory === cat ? 'active' : ''}`}
                      onClick={() => {
                        setAnalyticsCategory(cat);
                        const firstInCategory = overviewData.find(t => (t.category || 'Uncategorized') === cat);
                        if (firstInCategory) setAnalyticsTool(firstInCategory.id);
                      }}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                {analyticsCategory !== 'all' && (
                  <select
                    className="tool-select"
                    style={{ minWidth: 220 }}
                    value={analyticsTool}
                    onChange={(e) => setAnalyticsTool(e.target.value)}
                  >
                    {overviewData
                      .filter(t => (t.category || 'Uncategorized') === analyticsCategory)
                      .map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                  </select>
                )}
              </div>
            </div>

            {analyticsTool === 'all' ? (
              <>
                {/* Master KPI Cards (doc section 1) — same gradient-card
                    language as Overview, cycling the same 5-hue palette
                    across 9 cards. Trend badge only where real, same rule
                    as Overview's KPI row. */}
                {summaryData && (
                  <div className="kpi-grid" style={{ marginBottom: '1.5rem' }}>
                    <KpiCard icon={BarChart3} gradient={KPI_GRADIENTS[0]} label="Total / Completed Assessments" value={summaryData.totalAssessments} sub="Across all tools — completed only" trend={aggregateVolumeTrend(overviewData)} />
                    <KpiCard icon={Award} gradient={KPI_GRADIENTS[1]} label="Average Score" value={`${summaryData.averageScorePercentage}%`} sub="Weighted across tools" />
                    <KpiCard icon={Database} gradient={KPI_GRADIENTS[2]} label="Live Connections" value={`${summaryData.liveToolsCount} / ${summaryData.totalTools}`} sub={`${summaryData.mockToolsCount} using mock data`} />
                    <KpiCard icon={FileCheck2} gradient={KPI_GRADIENTS[3]} label="Reports Generated" value={reportsSummary ? reportsSummary.totalGenerated : '—'} sub={reportsSummary ? `${reportsSummary.successRate}% success rate` : 'Loading...'} />
                    <KpiCard icon={RefreshCw} gradient={KPI_GRADIENTS[4]} label="Reports Pending" value={0} sub="Always 0 — generated synchronously, no queue exists" />
                    <KpiCard icon={User} gradient={KPI_GRADIENTS[5]} label="Active Users (30d)" value={entitySummary ? entitySummary.activeUsers30d : '—'} sub={entitySummary ? `${entitySummary.totalUsers} unique all-time` : 'Loading...'} />
                    <KpiCard icon={BookOpen} gradient={KPI_GRADIENTS[6]} label="Active Organizations (30d)" value={entitySummary ? entitySummary.activeOrgs30d : '—'} sub={entitySummary ? `${entitySummary.totalOrganizations} unique all-time` : 'Loading...'} />
                    <KpiCard icon={AlertCircle} gradient={KPI_GRADIENTS[7]} label="Failed Requests" value={healthData ? Object.values(healthData).reduce((sum, h) => sum + h.errors, 0) : '—'} sub="DB query errors, not assessment failures" />
                    <KpiCard icon={Calendar} gradient={KPI_GRADIENTS[8]} label="Last Activity" value={<span style={{ fontSize: '1.15rem' }}>{summaryData.lastActivity ? new Date(summaryData.lastActivity).toLocaleString() : 'No activity yet'}</span>} sub="Most recent across tools" />
                    <KpiCard
                      icon={RefreshCw}
                      gradient={KPI_GRADIENTS[0]}
                      label="D30 Repeat-Assessment Rate"
                      value={entitySummary && entitySummary.retention ? `${entitySummary.retention.d30Pct}%` : 'N/A'}
                      sub={entitySummary && entitySummary.retention ? `of ${entitySummary.retention.cohortSize} tracked users came back within 30 days` : 'No tool with a stable user id has live data yet'}
                    />
                  </div>
                )}

                {/* Usage Activity Trend (doc section 3) */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={TrendingUp} color={CHART_COLORS.primary} />Assessment Activity Trend</h2>
                    <TrendRangeSelector
                      trendRange={trendRange}
                      setTrendRange={setTrendRange}
                      customStartDate={customStartDate}
                      setCustomStartDate={setCustomStartDate}
                      customEndDate={customEndDate}
                      setCustomEndDate={setCustomEndDate}
                    />
                  </div>
                  {trendLoading ? (
                    <div className="trend-chart-empty">Loading trend...</div>
                  ) : (
                    <TrendChart series={trendSeries} toolNames={toolNames} />
                  )}
                </div>

                {/* Volume + Score comparison across tools (doc section 2's
                    "which tool is used most / scores unusually low or high") */}
                <ToolComparisonCharts tools={overviewData} />

                {/* Tool-wise Monitoring (doc section 2) */}
                <h2 style={{ fontSize: '1.25rem', fontWeight: '600', marginBottom: '1rem' }}><PanelIconBadge icon={BarChart3} color={CHART_COLORS.secondary} />Tool-wise Monitoring</h2>
                <div className="table-section">
                  <div className="table-container">
                    <table className="custom-table custom-table-compact">
                      <thead>
                        <tr>
                          <th>Assessment</th>
                          <th>Mode</th>
                          <th>Records</th>
                          <th>Avg / Median</th>
                          <th>Score Mix</th>
                          <th>Reports</th>
                          <th>Error Rate</th>
                          <th>Last Activity</th>
                          <th>Trend</th>
                          <th>Health</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overviewData.map((item, idx) => {
                          const toolReports = reportsSummary && reportsSummary.byTool ? reportsSummary.byTool[item.id] : null;
                          const toolHealth = healthData ? healthData[item.id] : null;
                          return (
                            <tr key={item.id} onClick={() => { setAnalyticsCategory(item.category || 'Uncategorized'); setAnalyticsTool(item.id); }}>
                              <td>
                                <div className="table-tool-cell" title={item.description}>
                                  <span className="table-tool-icon" style={{ background: TOOL_PALETTE[idx % TOOL_PALETTE.length] }}>
                                    <Database size={14} color="#ffffff" />
                                  </span>
                                  <div>
                                    <div style={{ fontWeight: '600' }}>{item.name}</div>
                                    <span className="table-tool-category">{item.category}</span>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <span className={`mode-badge ${item.mode === 'live' ? 'live' : 'mock'}`}>
                                  {item.mode}
                                </span>
                              </td>
                              <td>{item.totalTestTakers}</td>
                              <td>{item.averageScorePercentage}% / {item.medianScorePercentage}%</td>
                              <td><MiniScoreBar distribution={item.scoreDistribution} /></td>
                              <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {toolReports ? `${toolReports.generated} ok / ${toolReports.failed} failed` : '—'}
                              </td>
                              <td style={{ fontSize: '0.8rem' }}>
                                {toolHealth && toolHealth.calls > 0 ? (
                                  <span style={{ color: toolHealth.errorRate > 20 ? 'var(--accent-danger)' : 'var(--text-secondary)' }}>
                                    {toolHealth.errorRate}%
                                  </span>
                                ) : '—'}
                              </td>
                              <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {item.lastActivity ? new Date(item.lastActivity).toLocaleDateString() : 'N/A'}
                              </td>
                              <td>
                                <TrendIndicator trend={item.trend} />
                              </td>
                              <td>
                                <span className={`health-status-pill ${toolHealth ? toolHealth.status : (item.mode === 'live' ? 'unknown' : 'mock')}`}>
                                  {toolHealth ? toolHealth.status : (item.mode === 'live' ? 'unknown' : 'mock')}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={(e) => { e.stopPropagation(); setAnalyticsCategory(item.category || 'Uncategorized'); setAnalyticsTool(item.id); }}
                                >
                                  View
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Tool Scoring/Ranking — Star/Growth/Maintain/Review tiers,
                    computed from usage + score + payment conversion (where
                    it exists) + real week-over-week trend. Not revenue- or
                    satisfaction-weighted — we don't have that data. */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={Star} color={CATEGORICAL_PALETTE[3]} />Tool Performance Tiers</h2>
                    <span
                      style={{ fontSize: '0.8rem', color: 'var(--accent-primary)', cursor: 'pointer', fontWeight: 600 }}
                      onClick={() => setCurrentView('tool-performance')}
                    >
                      Open full scorecard →
                    </span>
                  </div>
                  {toolScoring ? (
                    <ToolTierBoard
                      tools={toolScoring}
                      overviewData={overviewData}
                      onSelectTool={(dbId) => { setAnalyticsCategory(overviewData.find(t => t.id === dbId)?.category || 'Uncategorized'); setAnalyticsTool(dbId); }}
                    />
                  ) : <div className="trend-chart-empty">Loading tool tiers...</div>}
                </div>

                {/* Org Tool-Usage Breadth — cross-tool adoption depth per org */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={Building2} color={CHART_COLORS.secondary} />Org Tool Adoption</h2>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>How many of the 5 tools each org actually uses</span>
                  </div>
                  {orgBreadth ? <OrgBreadthChart data={orgBreadth} /> : <div className="trend-chart-empty">Loading org breadth...</div>}
                </div>

                {/* Acquisition — visitors/bounce/landing conversion via GA4, not
                    Supabase (see AcquisitionPanel comment for why) */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={Globe} color={CHART_COLORS.warning} />Acquisition</h2>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Traffic in from GA4, per tool</span>
                  </div>
                  <AcquisitionPanel data={acquisition} />
                </div>

                {/* Live Activity + Attention Required (doc sections 6, 15) */}
                <div className="split-grid">
                  <div className="panel">
                    <div className="panel-header">
                      <h2><PanelIconBadge icon={RefreshCw} color={CHART_COLORS.secondary} />Live Activity</h2>
                    </div>
                    <TodaySnapshot activityData={activityData} />
                    {activityData.length === 0 ? (
                      <div className="trend-chart-empty">No recent activity.</div>
                    ) : (
                      <div className="activity-feed">
                        {activityData.map((event, idx) => (
                          <div className="activity-item" key={idx}>
                            <span className={`activity-dot ${event.type}`}></span>
                            <span className="activity-text">
                              {event.type === 'assessment_completed' && (
                                <><strong>{event.candidateName}</strong> completed {event.tool}</>
                              )}
                              {event.type === 'report_generated' && (
                                <>Report generated for <strong>{event.candidateName}</strong> ({event.tool})</>
                              )}
                              {event.type === 'report_failed' && (
                                <>Report generation failed for <strong>{event.candidateName}</strong> ({event.tool})</>
                              )}
                            </span>
                            <span className="activity-time">{timeAgo(event.timestamp)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="panel">
                    <div className="panel-header">
                      <h2><PanelIconBadge icon={AlertTriangle} color={CHART_COLORS.warning} />Attention Required</h2>
                    </div>
                    <div className="alerts-list">
                      {alertsData.map((alert, idx) => <AlertRow alert={alert} key={idx} />)}
                    </div>
                  </div>
                </div>

                {/* System / Health Monitoring (doc section 14) */}
                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={HeartPulse} color={CHART_COLORS.success} />System Health</h2>
                    {reportsSummary && (
                      <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                        <span><FileCheck2 size={13} style={{ verticalAlign: '-2px' }} /> {reportsSummary.totalGenerated} generated / downloaded</span>
                        <span>{reportsSummary.totalFailed} failed</span>
                        <span>0 pending</span>
                        <span>{reportsSummary.totalRegenerated} regenerated</span>
                        <span>{reportsSummary.successRate}% success rate</span>
                        {reportsSummary.avgGenerationTimeMs !== null && (
                          <span>{reportsSummary.avgGenerationTimeMs}ms avg generation time</span>
                        )}
                        <span className={`health-status-pill ${reportsSummary.successRate >= 95 ? 'healthy' : reportsSummary.successRate >= 80 ? 'warning' : 'critical'}`}>
                          Report Service: {reportsSummary.successRate >= 95 ? 'Healthy' : reportsSummary.successRate >= 80 ? 'Degraded' : 'Critical'}
                        </span>
                      </div>
                    )}
                  </div>
                  <StatusGrid healthData={healthData} />
                </div>

              </>
            ) : (
              (() => {
                const tool = overviewData.find(i => i.id === analyticsTool);
                const toolAlerts = alertsData.filter(a => a.dbId === analyticsTool);
                return (
                  <>
                    {/* Particular Tool — Detailed Monitoring (doc section 5) */}
                    {tool && (
                      <div className="tool-status-header">
                        <div>
                          <h2><PanelIconBadge icon={Database} color={TOOL_PALETTE[Math.max(overviewData.findIndex(t => t.id === analyticsTool), 0) % TOOL_PALETTE.length]} />{tool.name}</h2>
                          <div className="tool-status-meta">
                            <span className={`status-dot ${tool.mode === 'live' ? 'online' : 'offline'}`}></span>
                            {tool.mode === 'live' ? 'Active / Live' : 'Active / Mock'}
                            <span style={{ margin: '0 0.5rem' }}>·</span>
                            Last activity {tool.lastActivity ? new Date(tool.lastActivity).toLocaleString() : 'N/A'}
                          </div>
                        </div>
                        <div className="tool-status-stats">
                          <div>
                            <span className="tool-status-value">{tool.totalTestTakers}</span>
                            <span className="tool-status-label">Attempts</span>
                          </div>
                          <div>
                            <span className="tool-status-value">{tool.averageScorePercentage}%</span>
                            <span className="tool-status-label">Avg Score</span>
                          </div>
                          <div>
                            <span className="tool-status-value">{tool.medianScorePercentage}%</span>
                            <span className="tool-status-label">Median Score</span>
                          </div>
                          <div>
                            <TrendIndicator trend={tool.trend} />
                            <span className="tool-status-label">7-Day Trend</span>
                          </div>
                        </div>
                        <button className="btn btn-primary btn-sm" onClick={() => setCurrentView(analyticsTool)}>
                          Manage Candidates
                        </button>
                      </div>
                    )}

                    {/* Score Monitoring (doc section 9) */}
                    {tool && (
                      <div className="panel">
                        <div className="panel-header">
                          <h2><PanelIconBadge icon={Award} color={CHART_COLORS.danger} />Score Distribution</h2>
                          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                            Min {tool.minScorePercentage}% · Max {tool.maxScorePercentage}%
                          </span>
                        </div>
                        <ScoreDistributionChart distribution={tool.scoreDistribution} />
                      </div>
                    )}

                    {/* Tool Usage Monitor, scoped (doc section 3) */}
                    <div className="panel">
                      <div className="panel-header">
                        <h2><PanelIconBadge icon={TrendingUp} color={CHART_COLORS.primary} />Activity Trend</h2>
                        <TrendRangeSelector
                          trendRange={trendRange}
                          setTrendRange={setTrendRange}
                          customStartDate={customStartDate}
                          setCustomStartDate={setCustomStartDate}
                          customEndDate={customEndDate}
                          setCustomEndDate={setCustomEndDate}
                        />
                      </div>
                      {trendLoading ? (
                        <div className="trend-chart-empty">Loading trend...</div>
                      ) : (
                        <TrendChart series={trendSeries} toolNames={toolNames} />
                      )}
                    </div>

                    {/* Tool-Specific Dimensions (doc section 10) */}
                    {dimensionData.supported && dimensionData.dimensions.length > 0 && (
                      <div className="panel">
                        <div className="panel-header">
                          <h2><PanelIconBadge icon={BarChart3} color={CHART_COLORS.warning} />Tool Dimensions</h2>
                        </div>
                        <div className="dimension-list">
                          {dimensionData.dimensions.map(dim => (
                            <div className="dimension-row" key={dim.key}>
                              <span className="dimension-label">{dim.label}</span>
                              <div className="dimension-track">
                                <div className="dimension-fill" style={{ width: `${dim.average ?? 0}%` }} />
                              </div>
                              <span className="dimension-value">{dim.average !== null ? `${dim.average}%` : 'N/A'}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Payment Monitoring — not in the original doc, added on request */}
                    {paymentData.supported && (
                      <div className="panel">
                        <div className="panel-header">
                          <h2><PanelIconBadge icon={FileCheck2} color={CHART_COLORS.success} />Payment Monitoring</h2>
                        </div>
                        <div className="kpi-grid" style={{ marginBottom: 0 }}>
                          <KpiCard icon={Check} gradient={KPI_GRADIENTS[2]} label="Paid" value={paymentData.paidCount} sub={`${paymentData.paymentRate}% conversion`} />
                          <KpiCard icon={AlertCircle} gradient={KPI_GRADIENTS[3]} label="Unpaid" value={paymentData.unpaidCount} sub="Not yet converted" />
                          {paymentData.hasRevenueAmount && (
                            <KpiCard icon={FileCheck2} gradient={KPI_GRADIENTS[0]} label="Total Revenue" value={`₹${paymentData.totalRevenue.toLocaleString()}`} sub="From paid records" />
                          )}
                        </div>
                        {paymentData.unpaidBreakdown && paymentData.unpaidBreakdown.length > 0 && (
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '1rem' }}>
                            Unpaid breakdown: {paymentData.unpaidBreakdown.map(b => `${b.count} ${b.status}`).join(' · ')}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Organization + User Monitoring (doc sections 11, 12) */}
                    {(orgBreakdown.supported || userBreakdown.supported) && (
                      <div className="split-grid">
                        {orgBreakdown.supported && (
                          <div className="panel">
                            <div className="panel-header">
                              <h2><PanelIconBadge icon={BookOpen} color={CHART_COLORS.secondary} />Organization Monitoring</h2>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {orgBreakdown.organizations.length} active organizations
                              </span>
                            </div>
                            {orgBreakdown.organizations.length === 0 ? (
                              <div className="trend-chart-empty">No organization data yet.</div>
                            ) : (
                              <div className="table-container">
                                {orgBreakdown.organizations.length > 1 && (
                                  <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                    <span>Most active: <strong>{orgBreakdown.organizations[0].organization}</strong></span>
                                    <span>Least active: <strong>{orgBreakdown.organizations[orgBreakdown.organizations.length - 1].organization}</strong></span>
                                  </div>
                                )}
                                <table className="custom-table">
                                  <thead>
                                    <tr>
                                      <th>Organization</th>
                                      <th>Assessments</th>
                                      <th>Avg Score</th>
                                      <th>Last Activity</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {orgBreakdown.organizations.slice(0, 10).map(org => (
                                      <tr key={org.organization}>
                                        <td>{org.organization}</td>
                                        <td>{org.totalAssessments}</td>
                                        <td>{org.averageScore}</td>
                                        <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                          {org.lastActivity ? new Date(org.lastActivity).toLocaleDateString() : 'N/A'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}

                        {userBreakdown.supported && (
                          <div className="panel">
                            <div className="panel-header">
                              <h2><PanelIconBadge icon={User} color={CHART_COLORS.primary} />User Monitoring</h2>
                              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                {userBreakdown.totalUniqueUsers} unique · {userBreakdown.averageAttemptsPerUser} avg attempts/user
                              </span>
                            </div>
                            {userBreakdown.users.length === 0 ? (
                              <div className="trend-chart-empty">No user data yet.</div>
                            ) : (
                              <div className="table-container">
                                {(() => {
                                  const newUsers = userBreakdown.users.filter(u => u.attempts === 1).length;
                                  const returningUsers = userBreakdown.users.filter(u => u.attempts > 1).length;
                                  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
                                  const activeUsers = userBreakdown.users.filter(u => u.lastActivity && new Date(u.lastActivity).getTime() >= thirtyDaysAgo).length;
                                  const avgUserScore = Math.round(userBreakdown.users.reduce((sum, u) => sum + u.averageScore, 0) / userBreakdown.users.length);
                                  return (
                                    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                                      <span>New: <strong>{newUsers}</strong></span>
                                      <span>Returning: <strong>{returningUsers}</strong></span>
                                      <span>Active (30d): <strong>{activeUsers}</strong></span>
                                      <span>Avg score across users: <strong>{avgUserScore}</strong></span>
                                    </div>
                                  );
                                })()}
                                <table className="custom-table">
                                  <thead>
                                    <tr>
                                      <th>User</th>
                                      <th>Attempts</th>
                                      <th>Avg Score</th>
                                      <th>Last Activity</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {userBreakdown.users.slice(0, 10).map(u => (
                                      <tr key={u.userId}>
                                        <td>{u.name}</td>
                                        <td>{u.attempts}</td>
                                        <td>{u.averageScore}</td>
                                        <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                          {u.lastActivity ? new Date(u.lastActivity).toLocaleDateString() : 'N/A'}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* System Health, scoped to this tool (doc section 17) */}
                    {healthData && healthData[analyticsTool] && (
                      <div className="panel">
                        <div className="panel-header">
                          <h2><PanelIconBadge icon={HeartPulse} color={CHART_COLORS.success} />System Health</h2>
                        </div>
                        {(() => {
                          const h = healthData[analyticsTool];
                          return (
                            <div className="health-grid">
                              {h.availability && (
                                <div className="health-card">
                                  <div className="health-card-header">
                                    <span>Tool Availability</span>
                                    <AvailabilityPill availability={h.availability} />
                                  </div>
                                  <div className="health-card-meta">
                                    {h.availability.url}
                                    {h.availability.statusCode && <> · HTTP {h.availability.statusCode}</>}
                                    <div>Checked: {new Date(h.availability.checkedAt).toLocaleString()}</div>
                                  </div>
                                </div>
                              )}
                              <div className="health-card">
                                <div className="health-card-header">
                                  <span>Assessment Service (DB queries)</span>
                                  <span className={`health-status-pill ${h.status}`}>{h.status}</span>
                                </div>
                                <div className="health-card-meta">
                                  {h.calls > 0 ? (
                                    <>{h.avgLatencyMs}ms avg · {h.errorRate}% error rate · {h.errors} failed requests ({h.calls} calls)</>
                                  ) : (
                                    <>No live query attempts yet</>
                                  )}
                                  {h.lastSuccessAt && <div>Last successful processing: {new Date(h.lastSuccessAt).toLocaleString()}</div>}
                                  {h.lastErrorAt && <div>Last error: {new Date(h.lastErrorAt).toLocaleString()} — {h.lastError}</div>}
                                </div>
                              </div>
                              {reportsSummary && (
                                <div className="health-card">
                                  <div className="health-card-header">
                                    <span>Report Service</span>
                                    <span className={`health-status-pill ${reportsSummary.successRate >= 95 ? 'healthy' : reportsSummary.successRate >= 80 ? 'warning' : 'critical'}`}>
                                      {reportsSummary.successRate >= 95 ? 'healthy' : reportsSummary.successRate >= 80 ? 'warning' : 'critical'}
                                    </span>
                                  </div>
                                  <div className="health-card-meta">
                                    {(reportsSummary.byTool[analyticsTool]?.generated) || 0} generated ·{' '}
                                    {(reportsSummary.byTool[analyticsTool]?.failed) || 0} failed
                                    {reportsSummary.avgGenerationTimeMs !== null && <> · {reportsSummary.avgGenerationTimeMs}ms avg</>}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    )}

                    {/* Live Activity + Attention Required, scoped (doc sections 6, 15) */}
                    <div className="split-grid">
                      <div className="panel">
                        <div className="panel-header">
                          <h2><PanelIconBadge icon={RefreshCw} color={CHART_COLORS.secondary} />Live Activity</h2>
                        </div>
                        <TodaySnapshot activityData={activityData} />
                        {activityData.length === 0 ? (
                          <div className="trend-chart-empty">No recent activity.</div>
                        ) : (
                          <div className="activity-feed">
                            {activityData.map((event, idx) => (
                              <div className="activity-item" key={idx}>
                                <span className={`activity-dot ${event.type}`}></span>
                                <span className="activity-text">
                                  {event.type === 'assessment_completed' && (
                                    <><strong>{event.candidateName}</strong> completed {event.tool}</>
                                  )}
                                  {event.type === 'report_generated' && (
                                    <>Report generated for <strong>{event.candidateName}</strong></>
                                  )}
                                  {event.type === 'report_failed' && (
                                    <>Report generation failed for <strong>{event.candidateName}</strong></>
                                  )}
                                </span>
                                <span className="activity-time">{timeAgo(event.timestamp)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="panel">
                        <div className="panel-header">
                          <h2><PanelIconBadge icon={AlertTriangle} color={CHART_COLORS.warning} />Attention Required</h2>
                        </div>
                        {toolAlerts.length === 0 ? (
                          <div className="trend-chart-empty">Nothing flagged for this tool.</div>
                        ) : (
                          <div className="alerts-list">
                            {toolAlerts.map((alert, idx) => <AlertRow alert={alert} key={idx} />)}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                );
              })()
            )}
          </div>
        )}

        {/* VIEW: ASSESSMENT DATABASE VIEWS (db1 - db5) */}
        {currentView.startsWith('db') && (
          <div>
            <div className="header-container">
              <div className="title-area">
                <h1>{assessmentName}</h1>
                <p>Browsing and managing database answers and scoring records.</p>
              </div>
              <div className="mode-badge-wrap" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <span className={`mode-badge ${assessmentMode === 'live' ? 'live' : 'mock'}`}>
                  {assessmentMode} Connection
                </span>
                <button className="btn btn-secondary btn-sm" onClick={() => {
                  const tool = overviewData.find(t => t.id === currentView);
                  setAnalyticsCategory((tool && tool.category) || 'Uncategorized');
                  setAnalyticsTool(currentView);
                  setCurrentView('analytics');
                }}>
                  <BarChart3 size={14} /> View Analytics
                </button>
              </div>
            </div>

            {loading ? (
              <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                <RefreshCw className="animate-spin" size={32} style={{ margin: '0 auto 1rem auto', animation: 'spin 1s linear infinite' }} />
                Fetching candidates database...
              </div>
            ) : (
              <div className="table-section">
                <div className="table-header">
                  <div className="search-bar">
                    <Search size={18} color="var(--text-muted)" />
                    <input
                      type="text"
                      placeholder="Search candidates by name or email..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Showing {filteredCandidates.length} of {candidates.length} records
                  </div>
                </div>

                <div className="table-container">
                  <table className="custom-table custom-table-compact">
                    <thead>
                      <tr>
                        <th>Candidate</th>
                        <th>Contact</th>
                        <th>Submitted</th>
                        <th>Score</th>
                        <th>Status</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCandidates.length === 0 ? (
                        <tr>
                          <td colSpan="6" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                            No candidates found matching filter criteria.
                          </td>
                        </tr>
                      ) : (
                        filteredCandidates.map((c, idx) => {
                          const scorePct = Math.round((c.score / c.maxScore) * 100);
                          const scoreClass = getScoreClass(c.score, c.maxScore);
                          const initials = c.name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
                          return (
                            <tr key={`${c.id}-${idx}`} onClick={() => handleSelectCandidate(c)}>
                              <td>
                                <div className="table-tool-cell">
                                  <span className="candidate-avatar" style={{ background: TOOL_PALETTE[idx % TOOL_PALETTE.length] }}>
                                    {initials}
                                  </span>
                                  <span style={{ fontWeight: '600' }}>{c.name}</span>
                                </div>
                              </td>
                              <td style={{ whiteSpace: 'normal' }}>
                                <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}><Mail size={13} /> {c.email}</div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.2rem' }}><Phone size={13} /> {c.phone || 'N/A'}</div>
                                </div>
                              </td>
                              <td style={{ color: 'var(--text-secondary)' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <Calendar size={14} /> {new Date(c.testDate).toLocaleDateString()}
                                </div>
                              </td>
                              <td style={{ fontWeight: '700' }}>
                                {c.score} / {c.maxScore}
                              </td>
                              <td>
                                <span className={`score-badge ${scoreClass}`}>
                                  {scorePct}% {scoreClass === 'high' ? 'Passed' : scoreClass === 'medium' ? 'Fair' : 'Review'}
                                </span>
                              </td>
                              <td>
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    downloadPdf(c.id, c.name);
                                  }}
                                  disabled={pdfLoading}
                                >
                                  <Download size={14} /> PDF
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* VIEW: TOOL PERFORMANCE — the org-head-grade per-tool scorecard.
            Distinct from the tier board embedded in Analytics: that one
            answers "which tools need attention right now" at a glance;
            this page is the full sortable table for deciding what to do
            about a specific tool — usage+trend, quality, revenue (only
            where real), org/user reach, live health, and the tier, all
            in one row, one merged backend call. */}
        {currentView === 'tool-performance' && (
          <div>
            <div className="header-container">
              <div className="title-area">
                <h1>Tool Performance</h1>
                <p>Every signal this panel can honestly compute, per tool, in one sortable scorecard.</p>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  setToolPerformance(null);
                  const res = await authFetch(`${API_BASE}/tool-performance`);
                  setToolPerformance((await res.json()).tools || []);
                }}
              >
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            {toolPerformance && toolPerformance.length > 0 && (() => {
              const tierCounts = toolPerformance.reduce((acc, t) => { acc[t.tier] = (acc[t.tier] || 0) + 1; return acc; }, {});
              return (
                <>
                  <div className="kpi-grid" style={{ marginBottom: '1.5rem' }}>
                    {Object.keys(TIER_META).map(tierKey => {
                      const meta = TIER_META[tierKey];
                      return (
                        <KpiCard
                          key={tierKey}
                          icon={meta.icon}
                          gradient={`linear-gradient(135deg, ${meta.color} 0%, ${meta.color}cc 100%)`}
                          label={meta.label}
                          value={tierCounts[tierKey] || 0}
                          sub={meta.blurb}
                        />
                      );
                    })}
                  </div>

                  <div className="split-grid">
                    <div className="panel">
                      <div className="panel-header">
                        <h2><PanelIconBadge icon={Award} color={CHART_COLORS.primary} />Composite Score by Tool</h2>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Colored by tier</span>
                      </div>
                      <ToolCompositeScoreChart tools={toolPerformance} />
                    </div>
                    <div className="panel">
                      <div className="panel-header">
                        <h2><PanelIconBadge icon={CreditCard} color={CHART_COLORS.secondary} />Quality vs Payment Conversion</h2>
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Same 0–100% axis</span>
                      </div>
                      <ToolQualityVsPaymentChart tools={toolPerformance} />
                    </div>
                  </div>
                </>
              );
            })()}

            <div className="panel">
              <ToolPerformanceTable
                tools={toolPerformance}
                sort={toolPerfSort}
                onSort={setToolPerfSort}
                onSelectTool={(dbId) => setCurrentView(dbId)}
              />
            </div>
          </div>
        )}

        {/* VIEW: WEEKLY REVIEW — no new data source. Same signals as the
            Attention Required panels on Overview/Analytics, re-grouped by
            /api/weekly-review into a fixed checklist (one row per topic)
            instead of one row per tool, so a weekly pass is a quick scan
            instead of hunting across pages. */}
        {currentView === 'weekly-review' && (
          <div>
            <div className="header-container">
              <div className="title-area">
                <h1>Weekly PM Review</h1>
                <p>{weeklyReview ? `Week of ${weeklyReview.weekLabel}` : 'Every tool, one topic per row — scan for what needs attention this week.'}</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={loadWeeklyReview}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            {weeklyReviewLoading && !weeklyReview ? (
              <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                <RefreshCw className="animate-spin" size={32} style={{ margin: '0 auto 1rem auto', animation: 'spin 1s linear infinite' }} />
                Building this week's checklist...
              </div>
            ) : weeklyReview && (
              <>
                <div className="kpi-grid" style={{ marginBottom: '1.5rem' }}>
                  <KpiCard icon={AlertTriangle} gradient={KPI_GRADIENTS[4]} label="Escalate" value={weeklyReview.summary.escalateCount} sub="Topics needing action now" />
                  <KpiCard icon={AlertTriangle} gradient={KPI_GRADIENTS[3]} label="Attention" value={weeklyReview.summary.attentionCount} sub="Worth a look this week" />
                  <KpiCard icon={CheckCircle2} gradient={KPI_GRADIENTS[2]} label="On Track" value={weeklyReview.summary.onTrackCount} sub="No issues detected" />
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <h2><PanelIconBadge icon={ListChecks} color={CHART_COLORS.primary} />This Week's Checklist</h2>
                  </div>
                  <div className="weekly-review-list">
                    {weeklyReview.rows.map(row => (
                      <WeeklyReviewRow row={row} key={row.category} />
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* VIEW: SETTINGS */}
        {currentView === 'settings' && (
          <div>
            <div className="header-container">
              <div className="title-area">
                <h1>Supabase Connection Manager</h1>
                <p>Provide API keys to dynamically link this portal to your 5 live Supabase projects.</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={resetAllConfigs}>
                Reset to Defaults
              </button>
            </div>

            <div className="config-grid">
              {dbStatuses && Object.keys(dbStatuses).map(dbId => (
                <div className="config-card" key={dbId}>
                  <div className="config-header">
                    <h3>{dbStatuses[dbId].name}</h3>
                    <span className={`mode-badge ${dbStatuses[dbId].connectionOk ? 'live' : 'mock'}`}>
                      {dbStatuses[dbId].mode}
                    </span>
                  </div>

                  <div className="form-group">
                    <label>Supabase Project URL</label>
                    <input
                      type="text"
                      className="form-control"
                      placeholder="https://xxxxxx.supabase.co"
                      value={configForms[dbId].url}
                      onChange={(e) => handleConfigChange(dbId, 'url', e.target.value)}
                    />
                  </div>

                  <div className="form-group">
                    <label>Supabase Anon Key or Service Role Key</label>
                    <input
                      type="password"
                      className="form-control"
                      placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                      value={configForms[dbId].key}
                      onChange={(e) => handleConfigChange(dbId, 'key', e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.25rem' }}>
                    <div style={{ fontSize: '0.85rem' }}>
                      {saveMessages[dbId] && (
                        <span style={{ color: saveMessages[dbId].type === 'success' ? 'var(--accent-success)' : 'var(--accent-danger)' }}>
                          {saveMessages[dbId].text}
                        </span>
                      )}
                    </div>
                    <button className="btn btn-primary btn-sm" onClick={() => saveConfig(dbId)}>
                      Connect Database
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* VIEW: SOCIAL — Phase 1 (Compose/Posts/Connect Accounts for
            YouTube + Google Business Profile). Components live under
            src/social/ but render inside this same shell, same as every
            other view above. */}
        {currentView === 'social-dashboard' && <SocialDashboard authFetch={authFetch} setCurrentView={setCurrentView} />}
        {currentView === 'social-compose' && <Composer authFetch={authFetch} />}
        {currentView === 'social-posts' && <SocialPosts authFetch={authFetch} setCurrentView={setCurrentView} />}
        {currentView === 'social-inbox' && <Inbox authFetch={authFetch} />}
        {currentView === 'social-analytics' && <Analytics authFetch={authFetch} />}
        {currentView === 'social-accounts' && <ConnectAccounts authFetch={authFetch} />}
        {canViewSales && currentView === 'leads-dashboard' && <LeadsDashboard authFetch={authFetch} setCurrentView={setCurrentView} />}
        {canViewSales && currentView === 'leads' && <Leads authFetch={authFetch} />}
      </main>

      {/* CANDIDATE DETAILS DRAWER SLIDE-OUT */}
      {selectedCandidate && (
        <div className="details-drawer-overlay" onClick={() => setSelectedCandidate(null)}>
          <div className="details-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header">
              <h2>Assessment Details</h2>
              <button className="close-btn" onClick={() => setSelectedCandidate(null)}>
                <X size={24} />
              </button>
            </div>

            <div className="drawer-content">
              {detailsLoading ? (
                <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                  <RefreshCw className="animate-spin" size={24} style={{ margin: '0 auto 1rem auto', animation: 'spin 1s linear infinite' }} />
                  Fetching candidate responses...
                </div>
              ) : (
                candidateDetails && (
                  <div>
                    <div className="candidate-profile-summary">
                      <div className="profile-info">
                        <h3>{candidateDetails.personalInfo.name}</h3>
                        <p>{candidateDetails.personalInfo.email}</p>
                        <p style={{ color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                          Taken on {new Date(candidateDetails.personalInfo.testDate).toLocaleString()}
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--text-secondary)' }}>AGGREGATE SCORE</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: '800', color: 'var(--accent-success)' }}>
                          {candidateDetails.personalInfo.score} / {candidateDetails.personalInfo.maxScore}
                        </div>
                        <button
                          className="btn btn-success btn-sm"
                          style={{ marginTop: '0.5rem' }}
                          onClick={() => downloadPdf(selectedCandidate.id, selectedCandidate.name)}
                          disabled={pdfLoading}
                        >
                          <Download size={14} /> Download PDF
                        </button>
                      </div>
                    </div>

                    {candidateDetails.aiProfile && (candidateDetails.aiProfile.profileName || candidateDetails.aiProfile.narrative) && (
                      <div className="ai-profile-card">
                        <div className="ai-profile-header">
                          <div>
                            <h4 style={{ marginBottom: '0.15rem' }}>{candidateDetails.aiProfile.profileName || 'AI Profile'}</h4>
                            {candidateDetails.aiProfile.personaType && (
                              <span className="ai-profile-tag">{candidateDetails.aiProfile.personaType}</span>
                            )}
                          </div>
                        </div>

                        {candidateDetails.aiProfile.narrative && (
                          <p className="ai-profile-narrative">{candidateDetails.aiProfile.narrative}</p>
                        )}

                        {candidateDetails.aiProfile.keyInsight && (
                          <div className="ai-profile-key-insight">
                            <strong>Key Insight:</strong> {candidateDetails.aiProfile.keyInsight}
                          </div>
                        )}

                        <div className="ai-profile-columns">
                          {candidateDetails.aiProfile.strengths && (
                            <div className="ai-profile-col">
                              <div className="ai-profile-col-title strengths">Strengths</div>
                              <ul className="ai-profile-list">
                                {(Array.isArray(candidateDetails.aiProfile.strengths)
                                  ? candidateDetails.aiProfile.strengths
                                  : [candidateDetails.aiProfile.strengths]
                                ).map((s, i) => <li key={i}>{renderProfileListItem(s)}</li>)}
                              </ul>
                            </div>
                          )}
                          {candidateDetails.aiProfile.blindSpots && (
                            <div className="ai-profile-col">
                              <div className="ai-profile-col-title blindspots">Blind Spots</div>
                              <ul className="ai-profile-list">
                                {(Array.isArray(candidateDetails.aiProfile.blindSpots)
                                  ? candidateDetails.aiProfile.blindSpots
                                  : [candidateDetails.aiProfile.blindSpots]
                                ).map((s, i) => <li key={i}>{renderProfileListItem(s)}</li>)}
                              </ul>
                            </div>
                          )}
                        </div>

                        {candidateDetails.aiProfile.improvements && (
                          <div className="ai-profile-col" style={{ marginTop: '0.75rem' }}>
                            <div className="ai-profile-col-title improvements">Improvement Areas</div>
                            <ul className="ai-profile-list">
                              {(Array.isArray(candidateDetails.aiProfile.improvements)
                                ? candidateDetails.aiProfile.improvements
                                : [candidateDetails.aiProfile.improvements]
                              ).map((s, i) => <li key={i}>{renderProfileListItem(s)}</li>)}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    <h4 style={{ fontSize: '1rem', fontWeight: '600', marginBottom: '1rem' }}>Test Questions & Answers</h4>
                    <div className="question-list">
                      {candidateDetails.results.map((item, index) => {
                        const isCorrect = item.score > 0 && item.score === item.maxScore;
                        return (
                          <div className="question-item" key={index}>
                            <div className="question-text">
                              Q{index + 1}: {item.question}
                            </div>
                            <pre className="answer-text">
                              {item.answer}
                            </pre>
                            <div className={`question-score-row ${isCorrect ? 'correct' : 'incorrect'}`}>
                              Points awarded: {item.score} / {item.maxScore}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;