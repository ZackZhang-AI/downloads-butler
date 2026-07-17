use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::SystemTime,
};
use tauri::Manager;

const CLASSIFICATION_RULES_JSON: &str = include_str!("../../src/shared/classificationRules.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassificationRules {
    invoice_keywords: Vec<String>,
    screenshot_keywords: Vec<String>,
    installer_extensions: Vec<String>,
    archive_extensions: Vec<String>,
    image_extensions: Vec<String>,
    document_extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSuggestion {
    id: String,
    name: String,
    path: String,
    size: u64,
    hash: Option<String>,
    created_at: Option<String>,
    modified_at: String,
    category: String,
    confidence: String,
    reason: String,
    suggested_name: String,
    suggested_relative_path: String,
    duplicate_group_id: Option<String>,
    selected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateGroup {
    id: String,
    size: u64,
    hash: String,
    files: Vec<FileSuggestion>,
    recommended_keep_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ButlerReport {
    total: usize,
    high_confidence: usize,
    duplicates: usize,
    unknown: usize,
    category_counts: HashMap<String, usize>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    suggestions: Vec<FileSuggestion>,
    duplicate_groups: Vec<DuplicateGroup>,
    report: ButlerReport,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyItem {
    id: String,
    path: String,
    suggested_relative_path: String,
    expected_hash: Option<String>,
    expected_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppliedOperation {
    id: String,
    before_path: String,
    after_path: String,
    file_name: String,
    status: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationBatch {
    id: String,
    timestamp: String,
    status: String,
    operations: Vec<AppliedOperation>,
    succeeded: usize,
    failed: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UndoFailure {
    file_name: String,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UndoResult {
    restored: usize,
    failed: Vec<UndoFailure>,
}

#[tauri::command]
fn scan_folder(folder_path: String) -> Result<ScanResult, String> {
    let folder = PathBuf::from(&folder_path);
    let mut files = Vec::new();
    let mut skipped_subfolders = 0;

    for entry in fs::read_dir(&folder).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            skipped_subfolders += 1;
            continue;
        }

        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let modified_at = system_time_to_iso(metadata.modified().unwrap_or(SystemTime::now()));
        let created_at = metadata.created().ok().map(system_time_to_iso);
        let hash = sha256_file(&path).map_err(|error| error.to_string())?;

        files.push(make_suggestion(
            &name,
            path.to_string_lossy().to_string(),
            metadata.len(),
            Some(hash),
            created_at,
            modified_at,
        )?);
    }

    let suggestions = resolve_suggestion_conflicts(attach_duplicate_groups(files));
    let duplicate_groups = duplicate_groups(&suggestions);
    let report = build_report(&suggestions);
    let warnings = if skipped_subfolders > 0 {
        vec![format!(
            "Skipped {} subfolders. This version scans first-level files only.",
            skipped_subfolders
        )]
    } else {
        Vec::new()
    };

    Ok(ScanResult {
        suggestions,
        duplicate_groups,
        report,
        warnings,
    })
}

#[tauri::command]
fn apply_operations(app: tauri::AppHandle, items: Vec<ApplyItem>) -> Result<OperationBatch, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let batch_id = format!("batch-{}", Utc::now().timestamp_millis());
    let timestamp = Utc::now().to_rfc3339();
    conn.execute(
        "insert into operation_batches (id, timestamp, status) values (?1, ?2, 'applied')",
        params![batch_id, timestamp],
    )
    .map_err(|error| error.to_string())?;

    let mut operations = Vec::new();
    for item in items {
        let source = PathBuf::from(&item.path);
        let base_dir = source.parent().unwrap_or_else(|| Path::new(""));
        let target = resolve_conflict(base_dir.join(&item.suggested_relative_path));
        let file_name = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| item.id.clone());

        if !source.exists() {
            operations.push(record_operation(
                &conn,
                &batch_id,
                &source,
                &target,
                &file_name,
                "failed",
                Some("source file does not exist"),
            )?);
            continue;
        }

        let metadata = source.metadata().map_err(|error| error.to_string())?;
        if let Some(expected_size) = item.expected_size {
            if metadata.len() != expected_size {
                operations.push(record_operation(
                    &conn,
                    &batch_id,
                    &source,
                    &target,
                    &file_name,
                    "failed",
                    Some("source size changed after scan"),
                )?);
                continue;
            }
        }

        if let Some(expected_hash) = &item.expected_hash {
            let current_hash = sha256_file(&source).map_err(|error| error.to_string())?;
            if &current_hash != expected_hash {
                operations.push(record_operation(
                    &conn,
                    &batch_id,
                    &source,
                    &target,
                    &file_name,
                    "failed",
                    Some("source hash changed after scan"),
                )?);
                continue;
            }
        }

        if let Some(parent) = target.parent() {
            if let Err(error) = fs::create_dir_all(parent) {
                operations.push(record_operation(
                    &conn,
                    &batch_id,
                    &source,
                    &target,
                    &file_name,
                    "failed",
                    Some(&error.to_string()),
                )?);
                continue;
            }
        }

        match fs::rename(&source, &target) {
            Ok(()) => operations.push(record_operation(
                &conn,
                &batch_id,
                &source,
                &target,
                &file_name,
                "applied",
                None,
            )?),
            Err(error) => operations.push(record_operation(
                &conn,
                &batch_id,
                &source,
                &target,
                &file_name,
                "failed",
                Some(&error.to_string()),
            )?),
        }
    }

    Ok(operation_batch(batch_id, timestamp, "applied".into(), operations))
}

#[tauri::command]
fn undo_last_operation(app: tauri::AppHandle) -> Result<UndoResult, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let batch_id: String = conn
        .query_row(
            "select id from operation_batches where status = 'applied' order by timestamp desc limit 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "No applied operation batch found".to_string())?;

    let mut statement = conn
        .prepare(
            "select id, before_path, after_path, file_name from operations
             where batch_id = ?1 and status = 'applied'
             order by id desc",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![batch_id.clone()], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut restored = 0;
    let mut failed = Vec::new();
    for row in rows {
        let (operation_id, before_path, after_path, file_name) = row.map_err(|error| error.to_string())?;
        let before = PathBuf::from(&before_path);
        let after = PathBuf::from(&after_path);
        if !after.exists() {
            failed.push(UndoFailure {
                file_name,
                reason: "moved file is missing".into(),
            });
            continue;
        }
        if before.exists() {
            failed.push(UndoFailure {
                file_name,
                reason: "original path already exists".into(),
            });
            continue;
        }
        if let Some(parent) = before.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        match fs::rename(&after, &before) {
            Ok(()) => {
                conn.execute(
                    "update operations set status = 'undone' where id = ?1",
                    params![operation_id],
                )
                .map_err(|error| error.to_string())?;
                restored += 1;
            }
            Err(error) => failed.push(UndoFailure {
                file_name,
                reason: error.to_string(),
            }),
        }
    }

    if failed.is_empty() {
        conn.execute(
            "update operation_batches set status = 'undone' where id = ?1",
            params![batch_id],
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(UndoResult { restored, failed })
}

#[tauri::command]
fn get_operation_history(app: tauri::AppHandle) -> Result<Vec<OperationBatch>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let mut statement = conn
        .prepare("select id, timestamp, status from operation_batches order by timestamp desc limit 20")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut batches = Vec::new();
    for row in rows {
        let (id, timestamp, status) = row.map_err(|error| error.to_string())?;
        let operations = load_operations(&conn, &id)?;
        batches.push(operation_batch(id, timestamp, status, operations));
    }

    Ok(batches)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            apply_operations,
            undo_last_operation,
            get_operation_history
        ])
        .run(tauri::generate_context!())
        .expect("error while running Downloads Butler");
}

fn make_suggestion(
    name: &str,
    path: String,
    size: u64,
    hash: Option<String>,
    created_at: Option<String>,
    modified_at: String,
) -> Result<FileSuggestion, String> {
    let (category, confidence, reason) = classify_file(name)?;
    let suggested_name = suggested_name(name, &category, &modified_at);
    Ok(FileSuggestion {
        id: stable_id(&path),
        name: name.to_string(),
        path,
        size,
        hash,
        created_at,
        modified_at,
        category: category.clone(),
        confidence: confidence.clone(),
        reason,
        suggested_relative_path: format!("{}/{}", category, suggested_name),
        suggested_name,
        duplicate_group_id: None,
        selected: confidence == "high",
    })
}

fn classify_file(name: &str) -> Result<(String, String, String), String> {
    let rules = classification_rules()?;
    let normalized = name.to_lowercase();
    let extension = extension(&normalized);

    if rules
        .invoice_keywords
        .iter()
        .any(|keyword| normalized.contains(&keyword.to_lowercase()))
    {
        return Ok(("Invoices".into(), "high".into(), "Matched invoice or billing keyword".into()));
    }
    if rules
        .screenshot_keywords
        .iter()
        .any(|keyword| normalized.contains(&keyword.to_lowercase()))
    {
        return Ok(("Screenshots".into(), "high".into(), "Matched screenshot keyword".into()));
    }
    if rules.installer_extensions.contains(&extension) {
        return Ok(("Installers".into(), "high".into(), "Matched installer extension".into()));
    }
    if rules.archive_extensions.contains(&extension) {
        return Ok(("Archives".into(), "high".into(), "Matched archive extension".into()));
    }
    if extension == ".pdf" {
        return Ok(("PDFs".into(), "medium".into(), "Matched PDF extension".into()));
    }
    if rules.image_extensions.contains(&extension) {
        return Ok(("Images".into(), "medium".into(), "Matched image extension".into()));
    }
    if rules.document_extensions.contains(&extension) {
        return Ok(("Documents".into(), "medium".into(), "Matched document extension".into()));
    }

    Ok(("Unknown".into(), "low".into(), "No rule matched".into()))
}

fn classification_rules() -> Result<ClassificationRules, String> {
    serde_json::from_str(CLASSIFICATION_RULES_JSON).map_err(|error| error.to_string())
}

fn attach_duplicate_groups(mut suggestions: Vec<FileSuggestion>) -> Vec<FileSuggestion> {
    let groups = duplicate_groups(&suggestions);
    let mut group_by_file: HashMap<String, String> = HashMap::new();
    for group in &groups {
        for file in &group.files {
            group_by_file.insert(file.id.clone(), group.id.clone());
        }
    }

    for suggestion in &mut suggestions {
        suggestion.duplicate_group_id = group_by_file.get(&suggestion.id).cloned();
    }
    suggestions
}

fn resolve_suggestion_conflicts(suggestions: Vec<FileSuggestion>) -> Vec<FileSuggestion> {
    let mut existing_paths: Vec<String> = Vec::new();
    suggestions
        .into_iter()
        .map(|mut suggestion| {
            let resolved = resolve_relative_conflict(&suggestion.suggested_relative_path, &existing_paths);
            existing_paths.push(resolved.clone());
            suggestion.suggested_name = resolved
                .rsplit('/')
                .next()
                .map(str::to_string)
                .unwrap_or_else(|| suggestion.suggested_name.clone());
            suggestion.suggested_relative_path = resolved;
            suggestion
        })
        .collect()
}

fn resolve_relative_conflict(relative_path: &str, existing_paths: &[String]) -> String {
    if !existing_paths.iter().any(|existing| existing == relative_path) {
        return relative_path.into();
    }

    let slash_index = relative_path.rfind('/');
    let (directory, file_name) = match slash_index {
        Some(index) => (&relative_path[..=index], &relative_path[index + 1..]),
        None => ("", relative_path),
    };
    let dot_index = file_name.rfind('.');
    let (stem, extension) = match dot_index {
        Some(index) => (&file_name[..index], &file_name[index..]),
        None => (file_name, ""),
    };

    for suffix in 1.. {
        let candidate = format!("{}{}-{}{}", directory, stem, suffix, extension);
        if !existing_paths.iter().any(|existing| existing == &candidate) {
            return candidate;
        }
    }
    unreachable!()
}

fn duplicate_groups(suggestions: &[FileSuggestion]) -> Vec<DuplicateGroup> {
    let mut buckets: HashMap<String, Vec<FileSuggestion>> = HashMap::new();
    for suggestion in suggestions {
        if let Some(hash) = &suggestion.hash {
            buckets
                .entry(format!("{}:{}", suggestion.size, hash))
                .or_default()
                .push(suggestion.clone());
        }
    }

    let mut index = 1;
    let mut groups = Vec::new();
    for (key, files) in buckets {
        if files.len() < 2 {
            continue;
        }
        let mut key_parts = key.splitn(2, ':');
        let size = key_parts.next().unwrap_or("0").parse().unwrap_or(0);
        let hash = key_parts.next().unwrap_or_default().to_string();
        let recommended_keep_id = files.first().map(|file| file.id.clone());
        groups.push(DuplicateGroup {
            id: format!("dup-{}", index),
            size,
            hash,
            files,
            recommended_keep_id,
        });
        index += 1;
    }
    groups
}

fn build_report(suggestions: &[FileSuggestion]) -> ButlerReport {
    let mut category_counts = HashMap::from([
        ("Invoices".into(), 0),
        ("Screenshots".into(), 0),
        ("PDFs".into(), 0),
        ("Images".into(), 0),
        ("Installers".into(), 0),
        ("Archives".into(), 0),
        ("Documents".into(), 0),
        ("Unknown".into(), 0),
    ]);
    let mut high_confidence = 0;
    let mut duplicates = 0;

    for suggestion in suggestions {
        *category_counts.entry(suggestion.category.clone()).or_insert(0) += 1;
        if suggestion.confidence == "high" {
            high_confidence += 1;
        }
        if suggestion.duplicate_group_id.is_some() {
            duplicates += 1;
        }
    }

    let unknown = *category_counts.get("Unknown").unwrap_or(&0);
    let message = if duplicates > 0 {
        format!(
            "I found {} duplicate suspects. I can organize them, but deletion remains off the menu.",
            duplicates
        )
    } else {
        format!(
            "I can tidy {} high-confidence files and refuse to delete anything. Caution is my best feature.",
            high_confidence
        )
    };

    ButlerReport {
        total: suggestions.len(),
        high_confidence,
        duplicates,
        unknown,
        category_counts,
        message,
    }
}

fn suggested_name(name: &str, category: &str, modified_at: &str) -> String {
    let ext = extension(&name.to_lowercase());
    let (date, time) = extract_date_parts(name).unwrap_or_else(|| date_parts_from_iso(modified_at));

    match category {
        "Invoices" => format!("invoice-unknown-{}{}", date, if ext.is_empty() { ".pdf" } else { &ext }),
        "Screenshots" if name.contains("微信图片") || name.to_lowercase().contains("wechat") => {
            format!("wechat-image-{}-{}{}", date, time, ext)
        }
        "Screenshots" => format!("screenshot-{}-{}{}", date, time, ext),
        _ => format!("{}-{}{}", sanitize_stem(remove_extension(name)), date, ext),
    }
}

fn extract_date_parts(name: &str) -> Option<(String, String)> {
    let digits: String = name.chars().filter(|char| char.is_ascii_digit()).collect();
    if digits.len() >= 12 && digits.starts_with("20") {
        let date = format!("{}-{}-{}", &digits[0..4], &digits[4..6], &digits[6..8]);
        let seconds = if digits.len() >= 14 { &digits[12..14] } else { "00" };
        return Some((date, format!("{}{}{}", &digits[8..10], &digits[10..12], seconds)));
    }

    None
}

fn date_parts_from_iso(value: &str) -> (String, String) {
    if value.len() >= 19 {
        return (value[0..10].to_string(), value[11..19].replace(':', ""));
    }
    ("unknown-date".into(), "000000".into())
}

fn extension(name: &str) -> String {
    if name.ends_with(".tar.gz") {
        return ".tar.gz".into();
    }
    Path::new(name)
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default()
}

fn remove_extension(name: &str) -> &str {
    if name.to_lowercase().ends_with(".tar.gz") {
        return &name[..name.len() - 7];
    }
    match name.rfind('.') {
        Some(index) => &name[..index],
        None => name,
    }
}

fn sanitize_stem(value: &str) -> String {
    let mut output = String::new();
    for char in value.to_lowercase().chars() {
        if char.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fa5}').contains(&char) {
            output.push(char);
        } else if !output.ends_with('-') {
            output.push('-');
        }
    }
    output.trim_matches('-').chars().take(64).collect()
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let bytes_read = file.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn resolve_conflict(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }

    let parent = path.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let extension = path.extension().map(|ext| ext.to_string_lossy().to_string());

    for suffix in 1.. {
        let file_name = match &extension {
            Some(ext) => format!("{}-{}.{}", stem, suffix, ext),
            None => format!("{}-{}", stem, suffix),
        };
        let candidate = parent.join(file_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn open_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let mut dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => dirs::data_dir().ok_or_else(|| "Could not locate an application data directory".to_string())?,
    };
    dir.push("Downloads Butler");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let db_path = dir.join("downloads-butler.sqlite");
    Connection::open(db_path).map_err(|error| error.to_string())
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        create table if not exists operation_batches (
            id text primary key,
            timestamp text not null,
            status text not null
        );
        create table if not exists operations (
            id text primary key,
            batch_id text not null,
            action_type text not null,
            before_path text not null,
            after_path text not null,
            file_name text,
            reversible integer not null,
            status text not null,
            error text,
            foreign key(batch_id) references operation_batches(id)
        );
        ",
    )
    .map_err(|error| error.to_string())?;

    add_column_if_missing(conn, "operations", "file_name", "text")
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, column_type: &str) -> Result<(), String> {
    let mut statement = conn
        .prepare(&format!("pragma table_info({})", table))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?;

    for existing in columns {
        if existing.map_err(|error| error.to_string())? == column {
            return Ok(());
        }
    }

    conn.execute(
        &format!("alter table {} add column {} {}", table, column, column_type),
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn record_operation(
    conn: &Connection,
    batch_id: &str,
    before: &Path,
    after: &Path,
    file_name: &str,
    status: &str,
    error: Option<&str>,
) -> Result<AppliedOperation, String> {
    let operation_id = format!("op-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default());
    let before_path = before.to_string_lossy().to_string();
    let after_path = after.to_string_lossy().to_string();
    conn.execute(
        "insert into operations (id, batch_id, action_type, before_path, after_path, file_name, reversible, status, error)
         values (?1, ?2, 'move', ?3, ?4, ?5, 1, ?6, ?7)",
        params![operation_id, batch_id, before_path, after_path, file_name, status, error],
    )
    .map_err(|error| error.to_string())?;

    Ok(AppliedOperation {
        id: operation_id,
        before_path,
        after_path,
        file_name: file_name.into(),
        status: status.into(),
        error: error.map(str::to_string),
    })
}

fn load_operations(conn: &Connection, batch_id: &str) -> Result<Vec<AppliedOperation>, String> {
    let mut statement = conn
        .prepare(
            "select id, before_path, after_path, coalesce(file_name, ''), status, error
             from operations where batch_id = ?1 order by id asc",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![batch_id], |row| {
            let before_path: String = row.get(1)?;
            let fallback_name = Path::new(&before_path)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| before_path.clone());
            let file_name: String = row.get(3)?;
            Ok(AppliedOperation {
                id: row.get(0)?,
                before_path,
                after_path: row.get(2)?,
                file_name: if file_name.is_empty() { fallback_name } else { file_name },
                status: row.get(4)?,
                error: row.get(5)?,
            })
        })
        .map_err(|error| error.to_string())?;

    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

fn operation_batch(id: String, timestamp: String, status: String, operations: Vec<AppliedOperation>) -> OperationBatch {
    let succeeded = operations.iter().filter(|operation| operation.status == "applied").count();
    let failed = operations.iter().filter(|operation| operation.status == "failed").count();
    OperationBatch {
        id,
        timestamp,
        status,
        operations,
        succeeded,
        failed,
    }
}

fn system_time_to_iso(time: SystemTime) -> String {
    let datetime: DateTime<Utc> = time.into();
    datetime.to_rfc3339()
}

fn stable_id(value: &str) -> String {
    let mut hash: i32 = 0;
    for byte in value.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(byte as i32);
    }
    format!("file-{}", hash.abs())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_real_chinese_keywords() {
        let invoice = classify_file("发票_20260623.pdf").expect("rules parse");
        assert_eq!(invoice.0, "Invoices");
        assert_eq!(invoice.1, "high");

        let screenshot = classify_file("微信图片_20260623102039.jpg").expect("rules parse");
        assert_eq!(screenshot.0, "Screenshots");
        assert_eq!(screenshot.1, "high");
    }

    #[test]
    fn groups_duplicates_by_size_and_hash() {
        let suggestions = attach_duplicate_groups(vec![
            make_suggestion(
                "a.pdf",
                "C:/Downloads/a.pdf".into(),
                10,
                Some("same".into()),
                None,
                "2026-06-23T00:00:00Z".into(),
            )
            .expect("suggestion"),
            make_suggestion(
                "b.pdf",
                "C:/Downloads/b.pdf".into(),
                10,
                Some("same".into()),
                None,
                "2026-06-23T00:00:00Z".into(),
            )
            .expect("suggestion"),
            make_suggestion(
                "c.pdf",
                "C:/Downloads/c.pdf".into(),
                20,
                Some("same".into()),
                None,
                "2026-06-23T00:00:00Z".into(),
            )
            .expect("suggestion"),
        ]);

        let groups = duplicate_groups(&suggestions);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].files.len(), 2);
    }
}
