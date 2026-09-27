import { db, transaction } from './db.js';

export const EXPENSE_CATEGORIES = {
  advertising: 'مسحوبات إعلانات',
  transfer: 'مسحوبات تحويلات',
  transfer_fee: 'نسب تحويلات',
  other: 'مصاريف أخرى'
};

export const WITHDRAWAL_CATEGORIES = {
  personal: 'سحب شخصي',
  profit: 'سحب أرباح',
  other: 'سحب آخر'
};

const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

export function getSettingsAt(dateStr) {
  const row = db.prepare('SELECT * FROM settings_history WHERE effective_on <= ? ORDER BY effective_on DESC, id DESC LIMIT 1').get(dateStr);
  return row || getSettings();
}

export function getPartnerUsers() {
  return db.prepare("SELECT id, username, display_name, partner_key, is_active FROM users WHERE role='partner' ORDER BY id").all();
}

export function periodBounds(dateStr, type, weekStart = 1, monthStart = 1) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (type === 'monthly') {
    let year = d.getUTCFullYear();
    let month = d.getUTCMonth();
    if (d.getUTCDate() < monthStart) month -= 1;
    if (month < 0) { year -= 1; month = 11; }
    const start = new Date(Date.UTC(year, month, monthStart));
    const end = new Date(Date.UTC(year, month + 1, monthStart));
    end.setUTCDate(end.getUTCDate() - 1);
    return { start: iso(start), end: iso(end) };
  }
  const dow = d.getUTCDay();
  const diff = (dow - weekStart + 7) % 7;
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - diff);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: iso(start), end: iso(end) };
}

function iso(d) { return d.toISOString().slice(0, 10); }

function allTransactionRows() {
  return db.prepare(`
    SELECT t.*, u.display_name AS partner_name, cb.display_name AS created_by_name
    FROM transactions t
    LEFT JOIN users u ON u.id=t.partner_id
    JOIN users cb ON cb.id=t.created_by
    WHERE t.deleted_at IS NULL
    ORDER BY t.occurred_on, t.id
  `).all();
}

function aggregateForPeriod(start, end) {
  const rows = db.prepare(`
    SELECT type, category, SUM(amount) AS total
    FROM transactions
    WHERE deleted_at IS NULL AND occurred_on BETWEEN ? AND ?
    GROUP BY type, category
  `).all(start, end);
  const totals = { income: 0, expenses: 0, advertising: 0, transfer: 0, transfer_fee: 0, other: 0, withdrawals: 0 };
  for (const r of rows) {
    const n = Number(r.total || 0);
    if (r.type === 'income') totals.income += n;
    else if (r.type === 'expense') {
      totals.expenses += n;
      if (r.category in totals) totals[r.category] += n;
    } else if (r.type === 'withdrawal') totals.withdrawals += n;
  }
  const operatingExpenses = totals.expenses;
  const netProfit = totals.income - operatingExpenses;
  return { ...Object.fromEntries(Object.entries(totals).map(([k,v]) => [k, round2(v)])), operatingExpenses: round2(operatingExpenses), netProfit: round2(netProfit) };
}

function allocationPeriodRows() {
  const s = getSettings();
  const bounds = db.prepare(`SELECT MIN(occurred_on) AS first_d, MAX(occurred_on) AS last_d FROM transactions WHERE deleted_at IS NULL AND type IN ('income','expense')`).get();
  const startDate = bounds?.first_d || iso(new Date());
  const endDate = bounds?.last_d || iso(new Date());
  const dates = [];
  let cursor = startDate;
  const maxPeriods = 10000;
  for (let i = 0; i < maxPeriods && cursor <= endDate; i++) {
    const p = periodBounds(cursor, 'weekly', s.accounting_week_start, s.accounting_month_start);
    if (!dates.find(x => x.start === p.start)) dates.push(p);
    const d = new Date(`${p.end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); cursor = iso(d);
  }
  return dates;
}

export function rebuildProfitLedger() {
  const partners = getPartnerUsers();
  const periods = allocationPeriodRows();
  const tx = () => transaction(() => {
    db.prepare("DELETE FROM ledger_entries WHERE entry_type IN ('profit_allocation','withdrawal')").run();
    db.prepare('DELETE FROM profit_allocations').run();
    db.prepare('DELETE FROM profit_periods').run();

    const insPeriod = db.prepare(`INSERT INTO profit_periods(period_type,start_date,end_date,total_income,total_operating_expenses,net_profit,retention_pct,retained_amount,distribution_pct,distributable_amount,calculated_at)
      VALUES ('weekly',?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);
    const insAlloc = db.prepare(`INSERT INTO profit_allocations(profit_period_id,partner_id,share_pct,allocated_amount) VALUES (?,?,?,?)`);
    const insLedger = db.prepare(`INSERT INTO ledger_entries(partner_id,entry_date,entry_type,amount,source_table,source_id,note,created_by) VALUES (?,?,?,?,?,?,?,?)`);

    for (const p of periods) {
      const a = aggregateForPeriod(p.start, p.end);
      const periodSettings = getSettingsAt(p.end);
      const netProfit = round2(a.netProfit);
      const distributableBase = Math.max(0, netProfit);
      const retained = round2(distributableBase * periodSettings.project_retention_pct / 100);
      const distributable = round2(distributableBase * periodSettings.distribution_pct / 100);
      const periodId = insPeriod.run(p.start, p.end, a.income, a.operatingExpenses, netProfit, periodSettings.project_retention_pct, retained, periodSettings.distribution_pct, distributable).lastInsertRowid;
      for (const partner of partners) {
        const sharePct = partner.partner_key === 'azam' ? periodSettings.azam_share_pct : periodSettings.waseem_share_pct;
        const allocated = round2(distributable * sharePct / 100);
        const allocId = insAlloc.run(periodId, partner.id, sharePct, allocated).lastInsertRowid;
        if (allocated !== 0) {
          insLedger.run(partner.id, p.end, 'profit_allocation', allocated, 'profit_allocations', allocId, `تخصيص أرباح للفترة ${p.start} إلى ${p.end}`, null);
        }
      }
    }
    const withdrawals = db.prepare(`SELECT id, partner_id, occurred_on, amount, note, created_by FROM transactions WHERE deleted_at IS NULL AND type='withdrawal' ORDER BY occurred_on,id`).all();
    for (const w of withdrawals) {
      insLedger.run(w.partner_id, w.occurred_on, 'withdrawal', w.amount, 'transactions', w.id, w.note || 'سحب', w.created_by);
    }
  });
  tx();
  recalcLedgerRunningBalances();
}

export function recalcLedgerRunningBalances() {
  // Running balances are exposed as computed values to avoid destructive updates.
  return true;
}

export function getPartnerBalance(partnerId) {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN entry_type='withdrawal' THEN -amount ELSE amount END),0) AS balance FROM ledger_entries WHERE partner_id=?`).get(partnerId);
  return round2(row.balance || 0);
}

export function getPartnerLedger(partnerId) {
  const rows = db.prepare(`SELECT l.*, pp.start_date, pp.end_date
    FROM ledger_entries l LEFT JOIN profit_allocations pa ON pa.id=l.source_id AND l.source_table='profit_allocations'
    LEFT JOIN profit_periods pp ON pp.id=pa.profit_period_id
    WHERE l.partner_id=? ORDER BY l.entry_date, l.id`).all(partnerId);
  let running = 0;
  return rows.map(r => {
    running = round2(r.entry_type === 'withdrawal' ? running - r.amount : running + r.amount);
    return { ...r, running_balance: running };
  });
}

export function getPartnerSummary(partnerId) {
  const settings = getSettings();
  const partner = db.prepare("SELECT id, username, display_name, partner_key FROM users WHERE id=? AND role='partner'").get(partnerId);
  if (!partner) return null;
  const allocations = db.prepare(`SELECT COALESCE(SUM(allocated_amount),0) AS total FROM profit_allocations WHERE partner_id=?`).get(partnerId).total;
  const withdrawals = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE partner_id=? AND type='withdrawal' AND deleted_at IS NULL`).get(partnerId).total;
  const balance = round2(allocations - withdrawals);
  const minAmount = round2(Math.max(0, balance) * settings.withdrawal_min_pct / 100);
  const maxAmount = round2(Math.max(0, balance) * settings.withdrawal_max_pct / 100);
  return {
    ...partner,
    share_pct: partner.partner_key === 'azam' ? settings.azam_share_pct : settings.waseem_share_pct,
    total_allocated: round2(allocations),
    total_withdrawals: round2(withdrawals),
    balance,
    min_withdrawal_amount: minAmount,
    max_withdrawal_amount: maxAmount,
    withdrawal_min_pct: settings.withdrawal_min_pct,
    withdrawal_max_pct: settings.withdrawal_max_pct,
    withdrawal_limit_period: settings.withdrawal_limit_period
  };
}

export function getCurrentPeriod(type = 'weekly') {
  return periodBounds(iso(new Date()), type, getSettings().accounting_week_start, getSettings().accounting_month_start);
}

export function getReport(type, start, end) {
  let bounds;
  if (type === 'custom') bounds = { start, end };
  else bounds = periodBounds(start || iso(new Date()), type, getSettings().accounting_week_start, getSettings().accounting_month_start);
  const a = aggregateForPeriod(bounds.start, bounds.end);
  const settings = getSettings();
  const retained = round2(Math.max(0, a.netProfit) * settings.project_retention_pct / 100);
  const distributable = round2(Math.max(0, a.netProfit) * settings.distribution_pct / 100);
  const partners = getPartnerUsers().map(p => {
    const summary = getPartnerSummary(p.id);
    const share = p.partner_key === 'azam' ? settings.azam_share_pct : settings.waseem_share_pct;
    const periodShare = round2(distributable * share / 100);
    const wd = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE partner_id=? AND type='withdrawal' AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ?`).get(p.id, bounds.start, bounds.end).total;
    return { id:p.id, name:p.display_name, share_pct:share, period_share:periodShare, period_withdrawals:round2(wd), accumulated_balance: summary.balance };
  });
  return { type, start:bounds.start, end:bounds.end, ...a, retention_pct:settings.project_retention_pct, retained_amount:retained, distribution_pct:settings.distribution_pct, distributable_amount:distributable, partners };
}

export function getDashboard() {
  const a = aggregateForPeriod('0000-01-01','9999-12-31');
  const totals = db.prepare(`SELECT COALESCE(SUM(retained_amount),0) AS retained, COALESCE(SUM(distributable_amount),0) AS distributable FROM profit_periods`).get();
  const settings = getSettings();
  return { ...a, retained_amount:round2(totals.retained), distributable_amount:round2(totals.distributable), settings, partners:getPartnerUsers().map(p=>getPartnerSummary(p.id)) };
}

export function getTransactions({ type, category, partnerId, start, end } = {}) {
  const clauses = ['t.deleted_at IS NULL']; const params=[];
  if (type) { clauses.push('t.type=?'); params.push(type); }
  if (category) { clauses.push('t.category=?'); params.push(category); }
  if (partnerId) { clauses.push('t.partner_id=?'); params.push(partnerId); }
  if (start) { clauses.push('t.occurred_on>=?'); params.push(start); }
  if (end) { clauses.push('t.occurred_on<=?'); params.push(end); }
  return db.prepare(`SELECT t.*, p.display_name AS partner_name, c.display_name AS created_by_name FROM transactions t LEFT JOIN users p ON p.id=t.partner_id JOIN users c ON c.id=t.created_by WHERE ${clauses.join(' AND ')} ORDER BY t.occurred_on DESC, t.id DESC`).all(...params);
}

export function validateWithdrawal(partnerId, amount, occurredOn, excludeTransactionId = null) {
  const s = getSettings();
  let summary = getPartnerSummary(partnerId);
  if (!summary) return { ok:false, reason:'الشريك غير موجود.' };
  if (excludeTransactionId) {
    const old = db.prepare(`SELECT amount FROM transactions WHERE id=? AND partner_id=? AND type='withdrawal' AND deleted_at IS NULL`).get(excludeTransactionId, partnerId);
    if (old) summary = { ...summary, total_withdrawals: round2(summary.total_withdrawals - old.amount), balance: round2(summary.balance + old.amount) };
    if (old) { summary.min_withdrawal_amount = round2(summary.balance * s.withdrawal_min_pct / 100); summary.max_withdrawal_amount = round2(summary.balance * s.withdrawal_max_pct / 100); }
  }
  if (summary.balance <= 0) return { ok:false, reason:'لا يوجد رصيد أرباح متاح للسحب.' };
  const minAmount = summary.min_withdrawal_amount;
  const maxAmount = summary.max_withdrawal_amount;
  if (amount < minAmount) return { ok:false, reason:`الحد الأدنى لهذه العملية هو ${minAmount}.` };
  if (amount > maxAmount) return { ok:false, reason:`الحد الأقصى لهذه العملية هو ${maxAmount}.` };

  const periodType = s.withdrawal_limit_period;
  const p = periodBounds(occurredOn, periodType, s.accounting_week_start, s.accounting_month_start);
  const credited = db.prepare(`SELECT COALESCE(SUM(l.amount),0) AS total FROM ledger_entries l WHERE l.partner_id=? AND l.entry_type='profit_allocation' AND l.entry_date BETWEEN ? AND ?`).get(partnerId,p.start,p.end).total;
  const openingRows = db.prepare(`SELECT COALESCE(SUM(CASE WHEN entry_type='withdrawal' THEN -amount ELSE amount END),0) AS balance FROM ledger_entries WHERE partner_id=? AND entry_date<?`).get(partnerId,p.start);
  const opening = Number(openingRows.balance || 0);
  const periodEligible = Math.max(0, round2(opening + Number(credited || 0)));
  const periodCap = round2(periodEligible * s.withdrawal_max_pct / 100);
  const prior = db.prepare(`SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE partner_id=? AND type='withdrawal' AND deleted_at IS NULL AND occurred_on BETWEEN ? AND ? ${excludeTransactionId ? 'AND id<>?' : ''}`).get(...(excludeTransactionId ? [partnerId,p.start,p.end,excludeTransactionId] : [partnerId,p.start,p.end])).total;
  if (periodCap > 0 && Number(prior) + amount > periodCap + 0.0001) return { ok:false, reason:`تجاوزت سقف السحب ${s.withdrawal_max_pct}% للفترة الحالية. المتبقي المسموح للفترة ${round2(periodCap-Number(prior))}.` };
  return { ok:true, minAmount, maxAmount, periodCap, prior:round2(prior) };
}
