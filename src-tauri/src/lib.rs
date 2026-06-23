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
struct AppliedOperation {
    id: String,
    before_path: String,
    after_path: String,
    file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperationBatch {
    id: String,
    timestamp: String,
    operations: Vec<AppliedOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoResult {
    restored: usize,
}

#[tauri::command]
fn scan_folder(folder_path: String) -> Result<Vec<FileSuggestion>, String> {
    let folder = PathBuf::from(&folder_path);
    let mut suggestions = Vec::new();

    for entry in fs::read_dir(&folder).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let modified_at = system_time_to_iso(metadata.modified().unwrap_or(SystemTime::now()));
        let created_at = metadata.created().ok().map(system_time_to_iso);
        let hash = sha256_file(&path).map_err(|error| error.to_string())?;

        suggestions.push(make_suggestion(
            &name,
            path.to_string_lossy().to_string(),
            metadata.len(),
            Some(hash),
            created_at,
            modified_at,
        ));
    }

    Ok(attach_duplicate_groups(suggestions))
}

#[tauri::command]
fn apply_operations(app: tauri::AppHandle, items: Vec<FileSuggestion>) -> Result<OperationBatch, String> {
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
        if !source.exists() {
            record_failed_operation(&conn, &batch_id, &item, "source file does not exist")?;
            continue;
        }

        let base_dir = source.parent().unwrap_or_else(|| Path::new(""));
        let target = resolve_conflict(base_dir.join(&item.suggested_relative_path));
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }

        match fs::rename(&source, &target) {
            Ok(()) => {
                let operation_id = format!("op-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default());
                let before_path = source.to_string_lossy().to_string();
                let after_path = target.to_string_lossy().to_string();
                conn.execute(
                    "insert into operations (id, batch_id, action_type, before_path, after_path, reversible, status, error)
                     values (?1, ?2, 'move', ?3, ?4, 1, 'applied', null)",
                    params![operation_id, batch_id, before_path, after_path],
                )
                .map_err(|error| error.to_string())?;
                operations.push(AppliedOperation {
                    id: operation_id,
                    before_path,
                    after_path,
                    file_name: item.name,
                });
            }
            Err(error) => record_failed_operation(&conn, &batch_id, &item, &error.to_string())?,
        }
    }

    Ok(OperationBatch {
        id: batch_id,
        timestamp,
        operations,
    })
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
            "select id, before_path, after_path from operations
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
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut restored = 0;
    for row in rows {
        let (operation_id, before_path, after_path) = row.map_err(|error| error.to_string())?;
        let before = PathBuf::from(&before_path);
        let after = PathBuf::from(&after_path);
        if !after.exists() || before.exists() {
            continue;
        }
        if let Some(parent) = before.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::rename(&after, &before).map_err(|error| error.to_string())?;
        conn.execute(
            "update operations set status = 'undone' where id = ?1",
            params![operation_id],
        )
        .map_err(|error| error.to_string())?;
        restored += 1;
    }

    conn.execute(
        "update operation_batches set status = 'undone' where id = ?1",
        params![batch_id],
    )
    .map_err(|error| error.to_string())?;

    Ok(UndoResult { restored })
}

#[tauri::command]
fn get_operation_history(app: tauri::AppHandle) -> Result<Vec<OperationBatch>, String> {
    let conn = open_database(&app)?;
    ensure_schema(&conn)?;

    let mut statement = conn
        .prepare("select id, timestamp from operation_batches order by timestamp desc limit 20")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(OperationBatch {
                id: row.get(0)?,
                timestamp: row.get(1)?,
                operations: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?;

    rows.map(|row| row.map_err(|error| error.to_string())).collect()
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
) -> FileSuggestion {
    let (category, confidence, reason) = classify_file(name);
    let suggested_name = suggested_name(name, &category, &modified_at);
    FileSuggestion {
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
    }
}

fn classify_file(name: &str) -> (String, String, String) {
    let normalized = name.to_lowercase();
    let extension = extension(&normalized);
    let invoice_keywords = ["invoice", "receipt", "bill", "order", "payment", "发票", "收据", "账单"];
    let screenshot_keywords = ["screenshot", "screen shot", "截屏", "屏幕截图", "wx", "wechat image", "微信图片"];

    if invoice_keywords.iter().any(|keyword| normalized.contains(keyword)) {
        return ("Invoices".into(), "high".into(), "Matched invoice or billing keyword".into());
    }
    if screenshot_keywords.iter().any(|keyword| normalized.contains(keyword)) {
        return ("Screenshots".into(), "high".into(), "Matched screenshot keyword".into());
    }
    if [".dmg", ".exe", ".pkg", ".msi", ".deb"].contains(&extension.as_str()) {
        return ("Installers".into(), "high".into(), "Matched installer extension".into());
    }
    if [".zip", ".rar", ".7z", ".tar.gz"].contains(&extension.as_str()) {
        return ("Archives".into(), "high".into(), "Matched archive extension".into());
    }
    if extension == ".pdf" {
        return ("PDFs".into(), "medium".into(), "Matched PDF extension".into());
    }
    if [".png", ".jpg", ".jpeg", ".webp", ".heic"].contains(&extension.as_str()) {
        return ("Images".into(), "medium".into(), "Matched image extension".into());
    }
    if [".docx", ".xlsx", ".pptx", ".txt", ".md"].contains(&extension.as_str()) {
        return ("Documents".into(), "medium".into(), "Matched document extension".into());
    }

    ("Unknown".into(), "low".into(), "No rule matched".into())
}

fn attach_duplicate_groups(mut suggestions: Vec<FileSuggestion>) -> Vec<FileSuggestion> {
    let mut buckets: HashMap<String, Vec<String>> = HashMap::new();
    for suggestion in &suggestions {
        if let Some(hash) = &suggestion.hash {
            buckets
                .entry(format!("{}:{}", suggestion.size, hash))
                .or_default()
                .push(suggestion.id.clone());
        }
    }

    let mut group_by_file: HashMap<String, String> = HashMap::new();
    let mut index = 1;
    for ids in buckets.values() {
        if ids.len() < 2 {
            continue;
        }
        let group_id = format!("dup-{}", index);
        index += 1;
        for id in ids {
            group_by_file.insert(id.clone(), group_id.clone());
        }
    }

    for suggestion in &mut suggestions {
        suggestion.duplicate_group_id = group_by_file.get(&suggestion.id).cloned();
    }
    suggestions
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
            reversible integer not null,
            status text not null,
            error text,
            foreign key(batch_id) references operation_batches(id)
        );
        ",
    )
    .map_err(|error| error.to_string())
}

fn record_failed_operation(
    conn: &Connection,
    batch_id: &str,
    item: &FileSuggestion,
    error: &str,
) -> Result<(), String> {
    conn.execute(
        "insert into operations (id, batch_id, action_type, before_path, after_path, reversible, status, error)
         values (?1, ?2, 'move', ?3, ?4, 1, 'failed', ?5)",
        params![
            format!("op-failed-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default()),
            batch_id,
            item.path,
            item.suggested_relative_path,
            error
        ],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
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
