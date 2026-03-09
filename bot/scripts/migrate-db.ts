import 'dotenv/config';
import { initDb, closeDb } from '../src/measurement/db.js';

console.log('Initializing database...');
initDb();
console.log('Database initialized successfully at data/vault.db');
closeDb();
