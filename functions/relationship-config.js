'use strict';

// Source of truth for relationship grade definitions, cadences, and engine rules.
// Consumed by: demotion sweep, promotion engine, backfill, and UI constants.
// Do NOT duplicate into the browser — the web UI imports cadences via GRADE_CONFIG in index.html.

const RELATIONSHIP_GRADES = {
  aplus: {
    label: 'A+ — Inner Circle',
    description: 'Strong trust, strong engagement, and mutual value.',
    definition: 'This is someone in my inner circle.',
    cadence: { targetDays: 14, yellowDays: 30, redDays: 60 },
    reconnectDays: 30,
    demotionMonths: 6,
    demotesTo: 'a',
  },
  a: {
    label: 'A — Active Relationship',
    description: 'Strong and healthy relationship with consistent engagement.',
    definition: 'This is an active relationship that I want to maintain long-term.',
    cadence: { targetDays: 30, yellowDays: 45, redDays: 90 },
    reconnectDays: 45,
    demotionMonths: 6,
    demotesTo: 'b',
  },
  b: {
    label: 'B — Growth Relationship',
    description: 'A developing relationship with future potential.',
    definition: 'This relationship has meaningful future potential.',
    cadence: { targetDays: 45, yellowDays: 60, redDays: 120 },
    reconnectDays: 90,
    demotionMonths: 12,
    demotesTo: 'c',
  },
  c: {
    label: 'C — Community Relationship',
    description: 'Part of your broader network but not an active relationship.',
    definition: 'This person is part of my network, but not currently an active relationship.',
    cadence: { targetDays: 90, yellowDays: 120, redDays: 180 },
    reconnectDays: 120,
    demotionMonths: 24,
    demotesTo: 'd',
  },
  d: {
    label: 'D — Dormant Relationship',
    description: 'Little or no active relationship today.',
    definition: 'There is little to no active relationship today.',
    cadence: { targetDays: 180, yellowDays: 365, redDays: null },
    reconnectDays: null, // D = no reconnect tasks
    demotionMonths: null,
    demotesTo: null,
  },
};

// Demotion logic (Decision #1: auto-demotion CAN override manually set grades;
// Decision #2: always surface as a suggestion — never a silent write).
// The engine will create a task of type 'demotion_suggestion' for user to confirm.
const DEMOTION_RULES = Object.entries(RELATIONSHIP_GRADES)
  .filter(([, g]) => g.demotionMonths !== null)
  .map(([grade, g]) => ({
    grade,
    thresholdDays: g.demotionMonths * 30,
    demotesTo: g.demotesTo,
  }));

module.exports = { RELATIONSHIP_GRADES, DEMOTION_RULES };
