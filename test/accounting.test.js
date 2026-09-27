import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'partner-ledger-'));
process.env.DB_PATH=path.join(dir,'test.sqlite');
process.env.JWT_SECRET='test-secret';
const { db, migrate, transaction } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const acct = await import('../src/accounting.js');
migrate();

db.prepare(`INSERT INTO users(username,display_name,role,password_hash,partner_key) VALUES ('admin','المدير','admin',?,NULL)`).run(hashPassword('x'));
db.prepare(`INSERT INTO users(username,display_name,role,password_hash,partner_key) VALUES ('azam','عزام','partner',?,'azam')`).run(hashPassword('x'));
db.prepare(`INSERT INTO users(username,display_name,role,password_hash,partner_key) VALUES ('waseem','وسيم','partner',?,'waseem')`).run(hashPassword('x'));
const admin=db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
const azam=db.prepare("SELECT id FROM users WHERE username='azam'").get().id;
const waseem=db.prepare("SELECT id FROM users WHERE username='waseem'").get().id;
function setHistory(date, vals={}){
  const base={azam_share_pct:50,waseem_share_pct:50,project_retention_pct:70,distribution_pct:30,withdrawal_min_pct:20,withdrawal_max_pct:30,withdrawal_limit_period:'weekly',accounting_week_start:1,accounting_month_start:1,partners_can_view_each_other:0};
  const v={...base,...vals};
  db.prepare(`INSERT INTO settings_history(effective_on,azam_share_pct,waseem_share_pct,project_retention_pct,distribution_pct,withdrawal_min_pct,withdrawal_max_pct,withdrawal_limit_period,accounting_week_start,accounting_month_start,partners_can_view_each_other,changed_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(date,v.azam_share_pct,v.waseem_share_pct,v.project_retention_pct,v.distribution_pct,v.withdrawal_min_pct,v.withdrawal_max_pct,v.withdrawal_limit_period,v.accounting_week_start,v.accounting_month_start,v.partners_can_view_each_other,admin);
  db.prepare(`UPDATE settings SET azam_share_pct=?,waseem_share_pct=?,project_retention_pct=?,distribution_pct=?,withdrawal_min_pct=?,withdrawal_max_pct=?,withdrawal_limit_period=?,accounting_week_start=?,accounting_month_start=?,partners_can_view_each_other=?,updated_by=? WHERE id=1`).run(v.azam_share_pct,v.waseem_share_pct,v.project_retention_pct,v.distribution_pct,v.withdrawal_min_pct,v.withdrawal_max_pct,v.withdrawal_limit_period,v.accounting_week_start,v.accounting_month_start,v.partners_can_view_each_other,admin);
}
setHistory('2026-01-01');
function addTx(date,amount,type,category,partnerId=null){return transaction(()=>db.prepare(`INSERT INTO transactions(occurred_on,amount,type,category,partner_id,created_by) VALUES (?,?,?,?,?,?)`).run(date,amount,type,category,partnerId,admin).lastInsertRowid)}
function reset(){db.prepare('DELETE FROM transactions').run();db.prepare('DELETE FROM settings_history').run();db.prepare(`UPDATE settings SET azam_share_pct=50,waseem_share_pct=50,project_retention_pct=70,distribution_pct=30,withdrawal_min_pct=20,withdrawal_max_pct=30,withdrawal_limit_period='weekly',accounting_week_start=1,accounting_month_start=1,partners_can_view_each_other=0,updated_by=? WHERE id=1`).run(admin);setHistory('2026-01-01');acct.rebuildProfitLedger()}
acct.rebuildProfitLedger();

// 1

test('1) 10,000 profit at 50/50 with 70/30 retention allocates 1,500 each',()=>{
  reset(); addTx('2026-09-01',10000,'income','operating_income'); acct.rebuildProfitLedger();
  assert.equal(acct.getPartnerSummary(azam).total_allocated,1500); assert.equal(acct.getPartnerSummary(waseem).total_allocated,1500);
});

// 2

test('2) One partner withdrawal does not change the other partner balance',()=>{
  const valid=acct.validateWithdrawal(azam,450,'2026-09-03'); assert.equal(valid.ok,true);
  addTx('2026-09-03',450,'withdrawal','profit',azam); acct.rebuildProfitLedger();
  assert.equal(acct.getPartnerSummary(azam).balance,1050);
  assert.equal(acct.getPartnerSummary(waseem).balance,1500);
});

// 3

test('3) A partner who does not withdraw keeps accumulating over periods',()=>{
  addTx('2026-09-15',10000,'income','operating_income'); acct.rebuildProfitLedger();
  assert.equal(acct.getPartnerSummary(waseem).balance,3000);
  assert.equal(acct.getPartnerSummary(azam).balance,2550);
});

// 4

test('4) Advertising expense is deducted before distribution',()=>{
  reset(); addTx('2026-09-01',10000,'income','operating_income'); addTx('2026-09-02',1000,'expense','advertising'); acct.rebuildProfitLedger();
  const d=acct.getDashboard(); assert.equal(d.netProfit,9000); assert.equal(acct.getPartnerSummary(azam).total_allocated,1350); assert.equal(acct.getPartnerSummary(waseem).total_allocated,1350);
});

// 5

test('5) Transfer and transfer-fee expenses are deducted and classified separately',()=>{
  reset(); addTx('2026-09-01',10000,'income','operating_income'); addTx('2026-09-02',500,'expense','transfer'); addTx('2026-09-03',100,'expense','transfer_fee'); acct.rebuildProfitLedger();
  const d=acct.getDashboard(); assert.equal(d.transfer,500); assert.equal(d.transfer_fee,100); assert.equal(d.netProfit,9400); assert.equal(acct.getPartnerSummary(azam).total_allocated,1410);
});

// 6

test('6) Withdrawal above maximum percentage is rejected',()=>{
  reset(); addTx('2026-09-01',10000,'income','operating_income'); acct.rebuildProfitLedger();
  const valid=acct.validateWithdrawal(azam,451,'2026-09-03'); assert.equal(valid.ok,false); assert.match(valid.reason,/الحد الأقصى/);
});

// 7

test('7) Retention change applies to later periods',()=>{
  reset(); setHistory('2026-09-10',{project_retention_pct:50,distribution_pct:50}); addTx('2026-09-15',10000,'income','operating_income'); acct.rebuildProfitLedger();
  const s=acct.getPartnerSummary(azam); assert.equal(s.total_allocated,2500);
});

// 8

test('8) Withdrawal percentage setting changes the allowed range',()=>{
  reset(); setHistory('2026-09-10',{withdrawal_min_pct:10,withdrawal_max_pct:40}); addTx('2026-09-15',10000,'income','operating_income'); acct.rebuildProfitLedger();
  const s=acct.getPartnerSummary(azam); assert.equal(s.min_withdrawal_amount,150); assert.equal(s.max_withdrawal_amount,600); assert.equal(acct.validateWithdrawal(azam,550,'2026-09-16').ok,true);
});

// 9

test('9) Editing/deleting an old income rebuilds allocations correctly',()=>{
  reset(); addTx('2026-09-01',10000,'income','operating_income'); addTx('2026-09-15',4000,'income','operating_income'); acct.rebuildProfitLedger(); assert.equal(acct.getPartnerSummary(azam).total_allocated,2100);
  const old=db.prepare("SELECT id FROM transactions WHERE occurred_on='2026-09-01' AND type='income'").get();
  db.prepare('UPDATE transactions SET amount=5000 WHERE id=?').run(old.id); acct.rebuildProfitLedger(); assert.equal(acct.getPartnerSummary(azam).total_allocated,1350);
  db.prepare("UPDATE transactions SET deleted_at='2026-09-20',deleted_by=? WHERE id=?").run(admin,old.id); acct.rebuildProfitLedger(); assert.equal(acct.getPartnerSummary(azam).total_allocated,600);
});

// 10

test('10) Personal withdrawal is a partner debit, not a project expense',()=>{
  reset(); addTx('2026-09-01',10000,'income','operating_income'); acct.rebuildProfitLedger();
  const before=acct.getDashboard().netProfit; addTx('2026-09-03',300,'withdrawal','personal',azam); acct.rebuildProfitLedger();
  assert.equal(acct.getDashboard().netProfit,before); assert.equal(acct.getPartnerSummary(azam).balance,1200); assert.equal(acct.getPartnerSummary(waseem).balance,1500);
});
