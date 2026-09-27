import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.DB_PATH || './data/ledger.sqlite';
fs.mkdirSync(path.dirname(dbPath), { recursive:true });
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');

export function migrate(){
  const dir=path.resolve('./db/migrations');
  const files=fs.readdirSync(dir).filter(f=>f.endsWith('.sql') && !f.endsWith('.down.sql')).sort();
  const applied=new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r=>r.version));
  for(const file of files){
    if(applied.has(file)) continue;
    const sql=fs.readFileSync(path.join(dir,file),'utf8');
    db.exec('BEGIN');
    try{db.exec(sql);db.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(file);db.exec('COMMIT');}
    catch(e){db.exec('ROLLBACK');throw e;}
  }
}

export function transaction(fn){
  db.exec('BEGIN');
  try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}
}
