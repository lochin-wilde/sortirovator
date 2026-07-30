#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::fs;
use std::path::Path;
use tauri::api::dialog;
use walkdir::WalkDir;
use id3::TagLike;

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<serde_json::Value>, String> {
    let mut tracks = Vec::new();
    for entry in WalkDir::new(&path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if let Some(ext) = path.extension() {
            if matches!(ext.to_str(), Some("mp3") | Some("wav") | Some("flac")) {
                let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let genre = get_genre_from_metadata(path);
                let confidence = if genre != "Unknown" { "high" } else { "low" };
                tracks.push(serde_json::json!({
                    "filename": filename,
                    "path": path.to_string_lossy().to_string(),
                    "genre": genre,
                    "confidence": confidence,
                    "status": "scanned"
                }));
            }
        }
    }
    Ok(tracks)
}

#[tauri::command]
fn sort_files(tracks: Vec<serde_json::Value>, output_dir: String) -> Result<(), String> {
    for track in tracks {
        let path = track["path"].as_str().unwrap();
        let genre = track["genre"].as_str().unwrap_or("Unknown");
        let genre_dir = Path::new(&output_dir).join(genre);
        fs::create_dir_all(&genre_dir).map_err(|e| e.to_string())?;
        let filename = Path::new(path).file_name().unwrap();
        let dest = genre_dir.join(filename);
        fs::rename(path, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn get_genre_from_metadata(path: &Path) -> String {
    if let Ok(tag) = id3::Tag::read_from_path(path) {
        if let Some(genre) = tag.genre() {
            return genre.to_string();
        }
    }
    "Unknown".to_string()
}

#[tauri::command]
fn select_folder() -> Result<String, String> {
    if let Some(path) = dialog::blocking::FileDialogBuilder::new()
        .set_directory(".")
        .pick_folder() {
        Ok(path.to_string_lossy().to_string())
    } else {
        Err("No folder selected".to_string())
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![scan_directory, sort_files, select_folder])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}