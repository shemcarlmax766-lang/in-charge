-- ============================================================================
-- BEM-FRS 001 — initial schema
-- SQLite. Normalized to 3NF where the relation is meaningful; all timestamps are
-- UTC ISO-8601 text (YYYY-MM-DDTHH:MM:SSZ), all date-only columns are YYYY-MM-DD.
-- Every enum is CHECK-constrained so bad data cannot be written even by a rogue
-- migration, script, or future developer.
-- ============================================================================
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- roles -----
-- Only three application roles exist. Permission *content* lives in
-- server/src/auth/capabilities.js (code = single source of truth, no drift);
-- this table exists so users.role_id is a real, referentially-integrity-checked FK.
CREATE TABLE roles (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE CHECK (code IN ('admin','technician','reporter')),
    name        TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL
);

INSERT INTO roles (id, code, name, description) VALUES
    (1,'admin','Administrator','Owns inventory, users, assignments, schedules, configuration and reporting.'),
    (2,'technician','Technician / Biomedical Engineer','Diagnoses, repairs, records parts and costs, performs preventive maintenance, verifies fixes.'),
    (3,'reporter','Student / Staff Reporter','Views equipment, reports faults with evidence and tracks their own reports. Cannot alter official records.');

-- --------------------------------------------------------------- users -----
CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    employee_id          TEXT UNIQUE,                    -- staff number / matriculation number
    full_name            TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 120),
    email                TEXT NOT NULL UNIQUE,           -- stored lowercase by the service layer
    phone                TEXT,
    job_title            TEXT,
    department           TEXT NOT NULL DEFAULT 'Biomedical Engineering',
    password_hash        TEXT NOT NULL,                  -- scrypt$N$r$p$salt$hash
    role_id              INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
    failed_attempts        INTEGER NOT NULL DEFAULT 0,   -- brute-force lockout counter
    locked_until           TEXT,
    last_login_at          TEXT,
    created_at           TEXT NOT NULL,
    updated_at             TEXT,
    created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    deactivated_at         TEXT,
    deactivated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_users_role ON users(role_id, is_active);
CREATE INDEX idx_users_email ON users(email);

-- Revocable server-side sessions. The browser gets an httpOnly cookie holding the
-- token; the DB stores only its SHA-256, so a DB leak does not leak live sessions.
CREATE TABLE sessions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    csrf_token   TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- ------------------------------------------------ configuration tables -----
CREATE TABLE equipment_categories (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,                    -- ECG, MON, CEN ...
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL
);

CREATE TABLE locations (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL UNIQUE,                    -- "Biomedical Lab 2"
    building    TEXT,
    floor       TEXT,
    room        TEXT,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL
);

CREATE TABLE fault_categories (
    id            INTEGER PRIMARY KEY,
    code          TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    default_severity TEXT NOT NULL DEFAULT 'medium'
                  CHECK (default_severity IN ('low','medium','high','critical')),
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at    TEXT NOT NULL
);

-- Small key/value config so nothing operational is hard-coded in the app.
CREATE TABLE app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    value_type  TEXT NOT NULL DEFAULT 'string' CHECK (value_type IN ('string','int','float','bool','json')),
    description TEXT,
    updated_at  TEXT NOT NULL,
    updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------ equipment ----
CREATE TABLE equipment (
    id                     INTEGER PRIMARY KEY,
    asset_tag              TEXT NOT NULL UNIQUE,       -- QR payload key, e.g. BMU-ECG-0007
    name                   TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
    category_id            INTEGER NOT NULL REFERENCES equipment_categories(id) ON DELETE RESTRICT,
    manufacturer           TEXT,
    model                  TEXT,
    serial_number          TEXT UNIQUE,
    department             TEXT NOT NULL DEFAULT 'Biomedical Engineering',
    location_id            INTEGER REFERENCES locations(id) ON DELETE SET NULL,
    custodian_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- responsible person
    custodian_note         TEXT,                                              -- e.g. "Lab 3 — Mr. Owusu"
    acquired_on            TEXT,                       -- purchase / acquisition date
    warranty_provider      TEXT,
    warranty_expires_on    TEXT,
    status                 TEXT NOT NULL DEFAULT 'operational' CHECK (status IN
        ('operational','reported_fault','under_inspection','under_repair',
         'awaiting_parts','out_of_service','decommissioned')),
    criticality            TEXT NOT NULL DEFAULT 'medium' CHECK (criticality IN
        ('low','medium','high','life_support')),      -- clinical/teaching criticality, drives SLA + risk
    notes                  TEXT,
    is_active              INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    maintenance_interval_days INTEGER CHECK (maintenance_interval_days IS NULL OR maintenance_interval_days BETWEEN 1 AND 3650),
    last_maintenance_on    TEXT,
    next_maintenance_on    TEXT,
    responsible_technician_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    qr_updated_at          TEXT,
    image_filename         TEXT,
    created_at             TEXT NOT NULL,
    updated_at             TEXT,
    created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
    decommissioned_at      TEXT,
    decommission_reason    TEXT
);
CREATE INDEX idx_eq_status      ON equipment(status, is_active);
CREATE INDEX idx_eq_category    ON equipment(category_id);
CREATE INDEX idx_eq_location    ON equipment(location_id);
CREATE INDEX idx_eq_next_pm     ON equipment(next_maintenance_on);
CREATE INDEX idx_eq_resp_tech   ON equipment(responsible_technician_id);
CREATE INDEX idx_eq_name        ON equipment(name);
-- Serial numbers are optional, but must be unique *when present*.
CREATE UNIQUE INDEX uq_eq_serial ON equipment(serial_number) WHERE serial_number IS NOT NULL AND trim(serial_number) <> '';

-- ------------------------------------------------------ fault reporting ----
CREATE TABLE fault_reports (
    id                INTEGER PRIMARY KEY,
    reference         TEXT NOT NULL UNIQUE,             -- FLT-2026-0001
    equipment_id      INTEGER NOT NULL REFERENCES equipment(id) ON DELETE RESTRICT,
    reported_by       INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    on_behalf_of      TEXT,                             -- e.g. a student name entered by a lab tech
    category_id       INTEGER NOT NULL REFERENCES fault_categories(id) ON DELETE RESTRICT,
    location_id       INTEGER REFERENCES locations(id) ON DELETE SET NULL,  -- where observed (snapshot)
    title             TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 4 AND 160),
    description       TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 10 AND 4000),
    severity          TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')),
    observed_at       TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'reported' CHECK (status IN
        ('reported','assigned','acknowledged','under_inspection','under_repair',
         'awaiting_parts','repaired','verified','closed')),
    assigned_to       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at       TEXT,
    due_at            TEXT,                             -- SLA target minted from severity at creation
    acknowledged_at   TEXT,
    repaired_at       TEXT,
    verified_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    verified_at       TEXT,
    closed_at         TEXT,
    -- Accountability: "diagnosed" may only ever be asserted by a technician/administrator.
    diagnosis_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (diagnosis_confirmed IN (0,1)),
    resolution_note   TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT
);
CREATE INDEX idx_fr_equipment ON fault_reports(equipment_id, status);
CREATE INDEX idx_fr_status    ON fault_reports(status);
CREATE INDEX idx_fr_reporter  ON fault_reports(reported_by, created_at);
CREATE INDEX idx_fr_tech      ON fault_reports(assigned_to, status);
CREATE INDEX idx_fr_sev       ON fault_reports(severity, status);
CREATE INDEX idx_fr_created   ON fault_reports(created_at);

CREATE TABLE fault_status_history (
    id          INTEGER PRIMARY KEY,
    fault_id    INTEGER NOT NULL REFERENCES fault_reports(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status   TEXT NOT NULL,
    comment     TEXT,
    auto_action INTEGER NOT NULL DEFAULT 0 CHECK (auto_action IN (0,1)), -- derived vs. human-chosen
    changed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    changed_at  TEXT NOT NULL
);
CREATE INDEX idx_fsh_fault ON fault_status_history(fault_id, changed_at);

-- Immutable trail of equipment status; used for downtime accounting.
CREATE TABLE equipment_status_history (
    id            INTEGER PRIMARY KEY,
    equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    from_status   TEXT,
    to_status     TEXT NOT NULL,
    reason        TEXT,
    fault_id      INTEGER REFERENCES fault_reports(id) ON DELETE SET NULL,
    changed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    changed_at    TEXT NOT NULL
);
CREATE INDEX idx_esh_eq ON equipment_status_history(equipment_id, changed_at);

-- ------------------------------------------------- preventive maintenance --
CREATE TABLE maintenance_schedules (
    id            INTEGER PRIMARY KEY,
    equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    interval_days INTEGER NOT NULL CHECK (interval_days BETWEEN 1 AND 3650),
    responsible_technician_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    next_due_on   TEXT NOT NULL,
    last_done_on  TEXT,
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    notes         TEXT,
    created_at    TEXT NOT NULL,
    created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at    TEXT
);
CREATE UNIQUE INDEX uq_sched_active ON maintenance_schedules(equipment_id, title) WHERE is_active = 1;
CREATE INDEX idx_sched_due ON maintenance_schedules(next_due_on, is_active);

-- Checklist items are rows, not JSON text, so results per run can be joined.
CREATE TABLE maintenance_checklist_items (
    id                INTEGER PRIMARY KEY,
    schedule_id       INTEGER NOT NULL REFERENCES maintenance_schedules(id) ON DELETE CASCADE,
    label             TEXT NOT NULL,
    requires_evidence INTEGER NOT NULL DEFAULT 0 CHECK (requires_evidence IN (0,1)),
    position          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_mci_sched ON maintenance_checklist_items(schedule_id, position);

CREATE TABLE maintenance_records (
    id            INTEGER PRIMARY KEY,
    reference     TEXT NOT NULL UNIQUE,                  -- PM-2026-0001
    equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    schedule_id   INTEGER REFERENCES maintenance_schedules(id) ON DELETE SET NULL,
    performed_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    performed_on  TEXT NOT NULL,                         -- date-only
    started_at    TEXT,
    completed_at  TEXT,
    duration_minutes INTEGER,
    findings      TEXT,
    actions_taken TEXT,
    condition_found  TEXT CHECK (condition_found IS NULL OR condition_found IN
        ('pass','pass_with_notes','needs_attention','needs_repair','replaced')),
    -- Snapshot of the date this PM was *due*, so lateness/compliance is measurable from
    -- the record itself instead of being reconstructed from the (already advanced) schedule.
    due_on        TEXT,
    days_late     INTEGER NOT NULL DEFAULT 0,
    next_due_on   TEXT,
    downtime_minutes INTEGER,
    created_at    TEXT NOT NULL
);
CREATE INDEX idx_mr_eq ON maintenance_records(equipment_id, performed_on);
CREATE INDEX idx_mr_tech ON maintenance_records(performed_by, performed_on);

CREATE TABLE maintenance_record_checklist (
    id            INTEGER PRIMARY KEY,
    record_id     INTEGER NOT NULL REFERENCES maintenance_records(id) ON DELETE CASCADE,
    item_id       INTEGER REFERENCES maintenance_checklist_items(id) ON DELETE SET NULL,
    label         TEXT NOT NULL,                          -- snapshot: survives item deletion
    outcome       TEXT NOT NULL CHECK (outcome IN ('pass','fail','na')),
    note          TEXT
);
CREATE INDEX idx_mrc_record ON maintenance_record_checklist(record_id);

-- ------------------------------------------------------------- repairs -----
CREATE TABLE repair_records (
    id                 INTEGER PRIMARY KEY,
    reference          TEXT NOT NULL UNIQUE,              -- RPR-2026-0001
    fault_id           INTEGER NOT NULL UNIQUE REFERENCES fault_reports(id) ON DELETE CASCADE,
    equipment_id       INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    technician_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    diagnosis          TEXT NOT NULL,
    root_cause         TEXT NOT NULL,
    troubleshooting    TEXT,
    repair_actions     TEXT NOT NULL,
    parts_replaced_summary TEXT,                           -- human summary; line items live in repair_parts
    test_results       TEXT NOT NULL,                      -- mandatory: equipment is not "operational" without it
    calibration_performed INTEGER NOT NULL DEFAULT 0 CHECK (calibration_performed IN (0,1)),
    calibration_details    TEXT,
    parts_cost         REAL NOT NULL DEFAULT 0 CHECK (parts_cost >= 0),
    labour_cost        REAL NOT NULL DEFAULT 0 CHECK (labour_cost >= 0),
    other_cost         REAL NOT NULL DEFAULT 0 CHECK (other_cost >= 0),
    total_cost         REAL NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
    currency           TEXT NOT NULL DEFAULT 'USD',
    safety_check_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (safety_check_confirmed IN (0,1)),
    safe_to_return_to_service INTEGER NOT NULL DEFAULT 1 CHECK (safe_to_return_to_service IN (0,1)),
    date_repaired      TEXT NOT NULL,                      -- date-only
    notes              TEXT,
    created_at         TEXT NOT NULL,
    created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at         TEXT,
    updated_by         INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_rr_eq ON repair_records(equipment_id, date_repaired);
CREATE INDEX idx_rr_tech ON repair_records(technician_id, date_repaired);

CREATE TABLE replacement_parts (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    category    TEXT,
    unit        TEXT NOT NULL DEFAULT 'pcs',
    unit_cost   REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    in_stock    INTEGER NOT NULL DEFAULT 0,               -- informational; not a full stores module
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT NOT NULL
);

CREATE TABLE repair_parts (
    id            INTEGER PRIMARY KEY,
    repair_id     INTEGER NOT NULL REFERENCES repair_records(id) ON DELETE CASCADE,
    part_id       INTEGER REFERENCES replacement_parts(id) ON DELETE SET NULL,
    part_name     TEXT NOT NULL,          -- snapshot / free-text part not in catalogue
    part_number   TEXT,
    serial_number TEXT,
    quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    unit_cost     REAL NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
    line_cost     REAL NOT NULL DEFAULT 0 CHECK (line_cost >= 0),
    recovered     INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0,1)) -- old part kept for warranty
);
CREATE INDEX idx_rp_repair ON repair_parts(repair_id);

-- ---------------------------------------------------------- attachments ----
-- Polymorphic owner (owner_type + owner_id). SQLite cannot FK this, so the owning
-- type is validated in code (ATTACHABLE map) and the id is existence-checked at insert.
CREATE TABLE attachments (
    id           INTEGER PRIMARY KEY,
    owner_type   TEXT NOT NULL CHECK (owner_type IN ('equipment','fault_report','repair_record','maintenance_record')),
    owner_id     INTEGER NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN
        ('photo','document','before_photo','after_photo','manual','certificate','qr_label')),
    stored_name  TEXT NOT NULL UNIQUE,
    filename     TEXT NOT NULL,
    mime_type    TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
    checksum     TEXT NOT NULL,            -- sha256
    caption      TEXT,
    uploaded_by  INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at   TEXT NOT NULL,
    is_deleted   INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0,1))
);
CREATE INDEX idx_att_owner ON attachments(owner_type, owner_id, kind);

-- ------------------------------------------------------- notifications -----
CREATE TABLE notifications (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN
        ('fault_critical','fault_assigned','fault_status_changed','fault_repaired',
         'maintenance_due','maintenance_overdue','equipment_out_of_service',
         'assignment_accepted','repair_completed','account')),
    title       TEXT NOT NULL,
    body        TEXT,
    link        TEXT,
    severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','success','warning','critical')),
    entity_type TEXT,
    entity_id   INTEGER,
    is_read     INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
    created_at  TEXT NOT NULL,
    read_at     TEXT
);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at);

-- Delivery is recorded per channel so email/SMS/push can be switched on later
-- without changing the notification model.
CREATE TABLE notification_deliveries (
    id              INTEGER PRIMARY KEY,
    notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    channel         TEXT NOT NULL CHECK (channel IN ('in_app','email','sms','push')),
    target          TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('sent','skipped','failed','pending')),
    detail          TEXT,
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_nd_notif ON notification_deliveries(notification_id, channel);

-- --------------------------------------------------------- audit log -------
CREATE TABLE audit_logs (
    id           INTEGER PRIMARY KEY,
    actor_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_role   TEXT,
    action       TEXT NOT NULL,                -- equipment.create, fault.transition, ...
    entity_type  TEXT NOT NULL,
    entity_id    INTEGER,
    entity_ref   TEXT,
    summary      TEXT,
    before_json  TEXT,
    after_json   TEXT,
    ip           TEXT,
    user_agent   TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX idx_audit_actor  ON audit_logs(actor_id, created_at);
CREATE INDEX idx_audit_action ON audit_logs(action, created_at);

-- Sequence table used to mint per-year human references without races.
CREATE TABLE id_sequences (
    key        TEXT PRIMARY KEY,
    last_value INTEGER NOT NULL
);

CREATE INDEX idx_mr_due ON maintenance_records(due_on, days_late);
