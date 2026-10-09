CREATE DATABASE IF NOT EXISTS contract_audit
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE contract_audit;

CREATE TABLE IF NOT EXISTS contract_parse_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(32) NOT NULL,
  contract_type VARCHAR(80) NOT NULL,
  key_elements_json JSON NOT NULL,
  paragraph_json JSON NOT NULL,
  ocr_confidence DECIMAL(5, 4) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contract_risk_audit_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  contract_type VARCHAR(80) NOT NULL,
  overall_level VARCHAR(8) NOT NULL,
  risk_score TINYINT UNSIGNED NOT NULL,
  audit_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operation_records (
  id CHAR(36) NOT NULL PRIMARY KEY,
  operation_type VARCHAR(64) NOT NULL,
  payload_json JSON NOT NULL,
  archived_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_operation_created_at (created_at DESC),
  INDEX idx_operation_type_archived (operation_type, archived_at)
);

CREATE TABLE IF NOT EXISTS risk_rule_library (
  rule_code VARCHAR(80) NOT NULL PRIMARY KEY,
  category VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  default_level VARCHAR(8) NOT NULL,
  rule_kind VARCHAR(24) NOT NULL,
  matcher_json JSON NOT NULL,
  reason_text TEXT NOT NULL,
  suggestion_text TEXT NOT NULL,
  source_note VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_risk_rule_active (is_active, rule_kind)
);

CREATE TABLE IF NOT EXISTS risk_evaluation_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dataset_name VARCHAR(80) NOT NULL,
  dataset_version VARCHAR(80) NULL,
  evaluator VARCHAR(80) NOT NULL,
  metrics_json JSON NOT NULL,
  notes TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_risk_evaluation_dataset (dataset_name, created_at DESC)
);

CREATE TABLE IF NOT EXISTS embedding_evaluation_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  model_name VARCHAR(160) NOT NULL,
  model_version VARCHAR(160) NOT NULL,
  embedding_dimension SMALLINT UNSIGNED NOT NULL,
  dataset_name VARCHAR(100) NOT NULL,
  metrics_json JSON NOT NULL,
  notes TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_embedding_evaluation_model (model_name, created_at DESC)
);

CREATE TABLE IF NOT EXISTS contract_versions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  contract_key CHAR(64) NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  source_file VARCHAR(255) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  change_summary VARCHAR(500) NOT NULL,
  summary_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_contract_version_content (contract_key, content_hash),
  UNIQUE KEY uq_contract_version_number (contract_key, version_number),
  INDEX idx_contract_version_file (source_file, created_at DESC)
);

CREATE TABLE IF NOT EXISTS managed_reports (
  id CHAR(36) NOT NULL PRIMARY KEY,
  contract_version_id CHAR(36) NOT NULL,
  source_file VARCHAR(255) NOT NULL,
  contract_type VARCHAR(80) NOT NULL,
  report_status VARCHAR(32) NOT NULL,
  reviewer_note VARCHAR(1000) NOT NULL DEFAULT '',
  review_updated_at DATETIME(3) NULL,
  report_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_managed_report_version (contract_version_id, created_at DESC),
  INDEX idx_managed_report_status (report_status, created_at DESC)
);

CREATE TABLE IF NOT EXISTS standard_contract_sources (
  source_key VARCHAR(255) NOT NULL PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(16) NOT NULL,
  contract_type_hint VARCHAR(80) NOT NULL,
  parse_status VARCHAR(32) NOT NULL,
  text_length INT UNSIGNED NOT NULL DEFAULT 0,
  warnings_json JSON NOT NULL,
  analyzed_at DATETIME(3) NOT NULL,
  metadata_json JSON NULL,
  INDEX idx_standard_source_status (parse_status, analyzed_at DESC)
);

CREATE TABLE IF NOT EXISTS standard_clause_library (
  clause_code VARCHAR(100) NOT NULL PRIMARY KEY,
  category VARCHAR(80) NOT NULL,
  title VARCHAR(160) NOT NULL,
  keywords_json JSON NOT NULL,
  requirements_json JSON NOT NULL,
  applicable_types_json JSON NOT NULL,
  suggestion_text TEXT NOT NULL,
  source_count INT UNSIGNED NOT NULL DEFAULT 0,
  source_examples_json JSON NOT NULL,
  origin VARCHAR(80) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL,
  metadata_json JSON NULL,
  INDEX idx_standard_clause_active (is_active, category)
);

CREATE TABLE IF NOT EXISTS famie_model_versions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  version_name VARCHAR(120) NOT NULL,
  original_file_name VARCHAR(255) NOT NULL,
  stored_file_name VARCHAR(255) NOT NULL,
  byte_length BIGINT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  model_status VARCHAR(48) NOT NULL,
  notes TEXT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_famie_model_created (created_at DESC),
  INDEX idx_famie_model_status (model_status)
);

CREATE TABLE IF NOT EXISTS semantic_vector_index (
  source_hash CHAR(64) NOT NULL PRIMARY KEY,
  source_kind VARCHAR(24) NOT NULL,
  source_key VARCHAR(255) NOT NULL,
  source_title VARCHAR(500) NOT NULL,
  source_text MEDIUMTEXT NOT NULL,
  embedding_json JSON NOT NULL,
  embedding_model VARCHAR(160) NOT NULL,
  embedding_model_version VARCHAR(160) NOT NULL,
  embedding_dimension SMALLINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_semantic_source_kind (source_kind, updated_at DESC),
  INDEX idx_semantic_source_key (source_key)
);
-- Immutable inputs and analysis runs are independent of deletable operation-log entries.
CREATE TABLE IF NOT EXISTS contract_parse_snapshots (
  id CHAR(36) PRIMARY KEY, source_file VARCHAR(255) NOT NULL, content_hash CHAR(64) NOT NULL,
  contract_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  INDEX idx_parse_snapshot_created (created_at)
);
CREATE TABLE IF NOT EXISTS contract_analysis_runs (
  id CHAR(36) PRIMARY KEY, parse_snapshot_id CHAR(36) NOT NULL, analysis_kind VARCHAR(32) NOT NULL,
  content_hash CHAR(64) NOT NULL, result_json JSON NOT NULL, created_at DATETIME(3) NOT NULL,
  INDEX idx_analysis_parse_kind (parse_snapshot_id, analysis_kind, created_at)
);

CREATE TABLE IF NOT EXISTS seal_reference_group (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(128) COLLATE utf8mb4_bin NOT NULL UNIQUE,
    seal_name VARCHAR(255) NOT NULL, company_name VARCHAR(255) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'active', sample_version BIGINT UNSIGNED NOT NULL DEFAULT 0,
    created_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) CHARACTER SET utf8mb4;
CREATE TABLE IF NOT EXISTS seal_reference_sample (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, group_id BIGINT UNSIGNED NOT NULL,
    source_file_name VARCHAR(512) NOT NULL, source_sha256 CHAR(64) NOT NULL, crop_sha256 CHAR(64) NOT NULL,
    source_path VARCHAR(1024) NOT NULL, image_path VARCHAR(1024) NOT NULL,
    page_number INT UNSIGNED NOT NULL, bbox JSON NOT NULL, roi_sha256 CHAR(64) NOT NULL,
    quality_score DECIMAL(5,2) NOT NULL, quality_metrics JSON NOT NULL,
    feature_count INT UNSIGNED NOT NULL, processing_version VARCHAR(64) NOT NULL,
    confirmation_status VARCHAR(24) NOT NULL DEFAULT 'confirmed', confirmed_at DATETIME(3) NOT NULL,
    provenance JSON NOT NULL, created_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_time DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY idx_seal_roi (source_sha256, page_number, roi_sha256),
    UNIQUE KEY idx_seal_crop (crop_sha256),
    INDEX idx_seal_group (group_id, confirmation_status),
    CONSTRAINT fk_seal_group FOREIGN KEY (group_id) REFERENCES seal_reference_group(id)
  ) CHARACTER SET utf8mb4;
