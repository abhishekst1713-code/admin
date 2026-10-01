export const LEADS_API_BASE = `${import.meta.env.VITE_API_BASE || 'http://localhost:5000'}/api/leads`;

export const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'proposal', label: 'Proposal' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' }
];

export const STATUS_COLOR = {
  new: 'var(--accent-primary)',
  contacted: 'var(--accent-warning)',
  qualified: 'var(--accent-warning)',
  proposal: 'var(--accent-warning)',
  won: 'var(--accent-success)',
  lost: 'var(--accent-danger)'
};
