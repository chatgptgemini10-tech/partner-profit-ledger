import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';

const file=process.argv[2];
if(!file){console.error('Usage: node src/rollback.js 001_initial.sql');process.exit(1)}
const down=path.resolve(`./db/migrations/${file.replace(/\.sql$/,'')}.down.sql`);
if(!fs.existsSync(down)) throw new Error(`Down migration not found: ${down}`);
db.exec('BEGIN');
try{
  db.exec(fs.readFileSync(down,'utf8'));
  db.prepare('DELETE FROM schema_migrations WHERE version=?').run(file);
  db.exec('COMMIT');
  console.log(`Rolled back ${file}`);
}catch(e){db.exec('ROLLBACK');throw e}
