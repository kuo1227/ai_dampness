-- AI 中醫濕氣檢測小幫手 - D1 Schema

CREATE TABLE IF NOT EXISTS user_sessions (
    line_user_id TEXT PRIMARY KEY,
    current_step INTEGER DEFAULT 0,
    answers_json TEXT, -- 存儲問診過程中的所有選擇 [{"q": "...", "a": "..."}]
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS diagnosis_reports (
    report_id INTEGER PRIMARY KEY AUTOINCREMENT,
    line_user_id TEXT,
    result_summary TEXT,
    severity_score INTEGER,
    full_report_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
