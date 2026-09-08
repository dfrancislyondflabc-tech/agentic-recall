#!/usr/bin/env node
// scripts/generate-fixture-book.js — the invented-facts validation book.
//
//   node scripts/generate-fixture-book.js [out.txt]
//
// WHY THIS EXISTS. Suite tests grade the ranker's OUTPUT (names, sections,
// scores), so pretraining cannot fake a pass there — but end-to-end validation
// ("ask a question, get the fact") needs content Claude cannot answer from
// pretraining. This book's facts are FABRICATED: invented company, invented
// machines, invented numbers, invented events. A correct answer PROVES
// retrieval, because the facts exist nowhere else.
//
// DETERMINISTIC BY DESIGN: the same bytes on every run, so the pre-registered
// questions in test/library-questions.json stay aimed at content that exists.
// Generated rather than committed as a data file (the trap-#6 lesson wants
// tokens generated at runtime, and a 150 KB blob in git is worse than the 3 KB
// of code that produces it).
//
// CONTAMINATION RULES (checked, not hoped): no real-world facts; no invented
// term collides with a benchmark probe term (scripts/probes.json, the d2
// absence probes, the RECALL query vocabulary).

import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'the-ozmirel-cartage-ledger.txt';

// The invented universe. Every load-bearing token here is checked against the
// benchmark vocabulary by eye and by the a45 scan's subject matter: nothing
// below names a real product, person, place, or the suite's probe terms.
const FACTS = {
  company: 'Ozmirel Cartage Company',
  founded: 1887,
  founder: 'Brellan Voss',
  hq: 'the canal town of Yendrick Hollow',
  fleetName: 'the Lantern Fleet',
  barges: 23,
  flagship: 'the barge Veltrag Nine',
  flagshipCapacity: '412 quarter-casks',
  engine: 'a twin-bellows kettle engine called the Murnwheel',
  enginePressure: '61 pole-atmospheres',
  rival: 'the Skenner Brothers Towing Concern',
  disaster: 'the Grey Sluice collapse of 1904',
  disasterLoss: 'nine barges and the season\'s entire tallow consignment',
  ledgerKeeper: 'Odile Fenwick',
  ledgerRule: 'no entry may be struck out; a wrong line is answered by a correcting line beneath it',
  tariff: 'four brass marks per hundredweight, halved for return cargo',
  route: 'the Copperline Run, thirty-one locks between Yendrick Hollow and the Parvel estuary',
  lockToll: 'one mark and a tallow candle per lock',
  winterRule: 'the fleet ties up when the Parvel gauge reads under three hands',
  successor: 'Marisel Voss-Fenwick',
  successorYear: 1921,
  cargoOath: 'the Quarter-Cask Oath, sworn on the flagship\'s murn-bell'
};

const filler = (seedText, n) => Array.from({ length: n }, (_, i) =>
  `${seedText} The clerks copied it fair in the evening book, and the ${(i % 2) ? 'senior' : 'junior'} ` +
  `hand initialled the margin as the standing practice required, page after page, season after season.`
).join(' ');

const CH = [];
CH.push(['The Founding at Yendrick Hollow',
  `${FACTS.company} was founded in ${FACTS.founded} by ${FACTS.founder}, a rope-merchant's son, at ${FACTS.hq}. ` +
  `From the first season the boats were known collectively as ${FACTS.fleetName}. ` +
  filler('The founding charter was read aloud at the lock-keeper\'s table.', 14)]);
CH.push(['The Lantern Fleet',
  `At its height ${FACTS.fleetName} counted ${FACTS.barges} barges. The largest, ${FACTS.flagship}, ` +
  `carried ${FACTS.flagshipCapacity} fully laden and was driven by ${FACTS.engine}, ` +
  `rated at ${FACTS.enginePressure}. ` +
  filler('Each barge carried its own lantern code for the night locks.', 14)]);
CH.push(['The Copperline Run',
  `The company's whole trade moved along ${FACTS.route}. The toll was ${FACTS.lockToll}, ` +
  `and the freight tariff stood at ${FACTS.tariff}. ` +
  filler('The lock-keepers kept their own counter-ledgers against dispute.', 14)]);
CH.push(['The Rivalry',
  `The company's only serious rival was ${FACTS.rival}, whose towmen raced the Lantern barges ` +
  `for berth order at the estuary. ` +
  filler('The rivalry was conducted mostly in tariffs and only twice in fists.', 14)]);
CH.push(['The Grey Sluice Collapse',
  `The worst season in the company's history followed ${FACTS.disaster}, which cost ` +
  `${FACTS.disasterLoss}. The fleet did not run the upper locks again for two years. ` +
  filler('The claims were paid in brass marks over eleven quarters.', 14)]);
CH.push(['The Ledger and its Keeper',
  `The evening book was kept for forty-one years by ${FACTS.ledgerKeeper}, under one rule: ` +
  `${FACTS.ledgerRule}. ` +
  filler('Auditors from the estuary praised the book and understood none of it.', 14)]);
CH.push(['Winter Rules',
  `Navigation ended each year by the gauge, not the calendar: ${FACTS.winterRule}. ` +
  filler('The tied-up months were spent on caulking and on settling the year\'s corrections.', 14)]);
CH.push(['The Succession',
  `In ${FACTS.successorYear} the company passed to ${FACTS.successor}, who kept the tariff, ` +
  `kept the ledger rule, and re-swore the crews to ${FACTS.cargoOath}. ` +
  filler('The succession was entered in the evening book as one plain line.', 14)]);

let body = `The Ozmirel Cartage Ledger\n\nA company history, compiled from the evening books.\n\n`;
CH.forEach(([title, text], i) => {
  body += `CHAPTER ${i + 1}. ${title}\n\n${text}\n\n`;
});
// Pad to ~150 KB with appendix pages that stay inside the invented universe.
let k = 0;
while (Buffer.byteLength(body) < 150 * 1024) {
  k++;
  body += `CHAPTER ${8 + k}. Season Notes, Year ${FACTS.founded + k}\n\n` +
    filler(`The year ${FACTS.founded + k} moved ${900 + (k * 7) % 400} hundredweight along the Copperline Run.`, 12) + '\n\n';
}

writeFileSync(out, body, 'utf8');
console.log(`wrote ${out}: ${Buffer.byteLength(body)} bytes, ${8 + k} chapters (deterministic)`);
