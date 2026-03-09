import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { initDb, closeDb } from '../src/measurement/db.js';
import { exportDailyPnlCsv, exportEventsCsv, exportSnapshotsCsv, exportAuditJson } from '../src/measurement/export.js';

const args = process.argv.slice(2);
const from = args[0] || '2020-01-01';
const to = args[1] || new Date().toISOString().split('T')[0]!;
const outputDir = args[2] || 'data/export';

initDb();

mkdirSync(outputDir, { recursive: true });

console.log(`Exporting data from ${from} to ${to}...`);

// CSV exports
writeFileSync(`${outputDir}/daily_pnl.csv`, exportDailyPnlCsv(from, to));
console.log('  daily_pnl.csv');

writeFileSync(`${outputDir}/events.csv`, exportEventsCsv(from, to));
console.log('  events.csv');

writeFileSync(`${outputDir}/snapshots.csv`, exportSnapshotsCsv(from, to));
console.log('  snapshots.csv');

// JSON audit report
const audit = exportAuditJson();
writeFileSync(`${outputDir}/audit.json`, JSON.stringify(audit, null, 2));
console.log('  audit.json');

closeDb();
console.log(`Export complete → ${outputDir}/`);
