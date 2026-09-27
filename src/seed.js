import { db, migrate, transaction } from './db.js';
import { hashPassword } from './auth.js';
import { rebuildProfitLedger } from './accounting.js';

migrate();
const tx=()=>transaction(()=>{
  const insert=db.prepare(`INSERT OR IGNORE INTO users(username,display_name,role,password_hash,partner_key) VALUES (?,?,?,?,?)`);
  insert.run('admin','المدير','admin',hashPassword('admin123'),null);
  insert.run('azam','عزام','partner',hashPassword('azam123'),'azam');
  insert.run('waseem','وسيم','partner',hashPassword('waseem123'),'waseem');
  const admin=db.prepare("SELECT id FROM users WHERE username='admin'").get();
  const existing=db.prepare('SELECT COUNT(*) AS c FROM settings_history').get().c;
  if(!existing){
    const s=db.prepare('SELECT * FROM settings WHERE id=1').get();
    db.prepare(`INSERT INTO settings_history(effective_on,azam_share_pct,waseem_share_pct,project_retention_pct,distribution_pct,withdrawal_min_pct,withdrawal_max_pct,withdrawal_limit_period,accounting_week_start,accounting_month_start,partners_can_view_each_other,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(new Date().toISOString().slice(0,10),s.azam_share_pct,s.waseem_share_pct,s.project_retention_pct,s.distribution_pct,s.withdrawal_min_pct,s.withdrawal_max_pct,s.withdrawal_limit_period,s.accounting_week_start,s.accounting_month_start,s.partners_can_view_each_other,admin.id);
  }
});
tx();
rebuildProfitLedger();
console.log('Seed complete. Login: admin/admin123, azam/azam123, waseem/waseem123');
