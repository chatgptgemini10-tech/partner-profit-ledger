PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','partner')),
  password_hash TEXT NOT NULL,
  partner_key TEXT UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  azam_share_pct REAL NOT NULL DEFAULT 50,
  waseem_share_pct REAL NOT NULL DEFAULT 50,
  project_retention_pct REAL NOT NULL DEFAULT 70,
  distribution_pct REAL NOT NULL DEFAULT 30,
  withdrawal_min_pct REAL NOT NULL DEFAULT 20,
  withdrawal_max_pct REAL NOT NULL DEFAULT 30,
  withdrawal_limit_period TEXT NOT NULL DEFAULT 'weekly' CHECK (withdrawal_limit_period IN ('weekly','monthly')),
  accounting_week_start INTEGER NOT NULL DEFAULT 1 CHECK (accounting_week_start BETWEEN 0 AND 6),
  accounting_month_start INTEGER NOT NULL DEFAULT 1 CHECK (accounting_month_start BETWEEN 1 AND 28),
  partners_can_view_each_other INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER,
  FOREIGN KEY (updated_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  effective_on TEXT NOT NULL,
  azam_share_pct REAL NOT NULL,
  waseem_share_pct REAL NOT NULL,
  project_retention_pct REAL NOT NULL,
  distribution_pct REAL NOT NULL,
  withdrawal_min_pct REAL NOT NULL,
  withdrawal_max_pct REAL NOT NULL,
  withdrawal_limit_period TEXT NOT NULL,
  accounting_week_start INTEGER NOT NULL,
  accounting_month_start INTEGER NOT NULL,
  partners_can_view_each_other INTEGER NOT NULL DEFAULT 0,
  changed_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (changed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_on TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount >= 0),
  type TEXT NOT NULL CHECK (type IN ('income','expense','withdrawal')),
  category TEXT NOT NULL,
  partner_id INTEGER,
  note TEXT,
  reference TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT,
  deleted_at TEXT,
  deleted_by INTEGER,
  FOREIGN KEY (partner_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (deleted_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS profit_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_type TEXT NOT NULL CHECK (period_type IN ('weekly','monthly')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  total_income REAL NOT NULL DEFAULT 0,
  total_operating_expenses REAL NOT NULL DEFAULT 0,
  net_profit REAL NOT NULL DEFAULT 0,
  retention_pct REAL NOT NULL DEFAULT 70,
  retained_amount REAL NOT NULL DEFAULT 0,
  distribution_pct REAL NOT NULL DEFAULT 30,
  distributable_amount REAL NOT NULL DEFAULT 0,
  calculated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period_type, start_date, end_date)
);

CREATE TABLE IF NOT EXISTS profit_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profit_period_id INTEGER NOT NULL,
  partner_id INTEGER NOT NULL,
  share_pct REAL NOT NULL,
  allocated_amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(profit_period_id, partner_id),
  FOREIGN KEY (profit_period_id) REFERENCES profit_periods(id) ON DELETE CASCADE,
  FOREIGN KEY (partner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL,
  entry_date TEXT NOT NULL,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('profit_allocation','withdrawal','adjustment')),
  amount REAL NOT NULL,
  source_table TEXT,
  source_id INTEGER,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id) REFERENCES users(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE INDEX IF NOT EXISTS idx_settings_history_effective_on ON settings_history(effective_on);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred_on ON transactions(occurred_on);
CREATE INDEX IF NOT EXISTS idx_transactions_type_category ON transactions(type, category);
CREATE INDEX IF NOT EXISTS idx_ledger_partner_date ON ledger_entries(partner_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
