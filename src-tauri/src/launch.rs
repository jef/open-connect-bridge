use serde_json::{Map, Value};
use std::{
    fmt::Display,
    fs, io,
    path::{Path, PathBuf},
};

pub type Locations = Map<String, Value>;

pub fn valid_source(source: &str) -> Result<(), String> {
    if source == "gspro" || source == "premier" {
        Ok(())
    } else {
        Err("Invalid launch monitor app".into())
    }
}

pub fn read_locations(settings: &Path) -> Result<Locations, String> {
    let text = match fs::read_to_string(settings) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Locations::new()),
        Err(e) => return Err(format!("Cannot read quick launch settings: {e}")),
    };
    serde_json::from_str(&text).map_err(|e| format!("Invalid quick launch settings: {e}"))
}

pub fn save_location(settings: &Path, source: &str, location: &str) -> Result<(), String> {
    valid_source(source)?;
    if location.trim().is_empty() {
        return Err("Application path is empty".into());
    }
    let mut locations = read_locations(settings)?;
    locations.insert(source.into(), Value::String(location.into()));
    fs::create_dir_all(settings.parent().ok_or("Invalid settings path")?)
        .map_err(|e| e.to_string())?;
    fs::write(
        settings,
        serde_json::to_string_pretty(&locations).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn saved_location(locations: &Locations, source: &str) -> Result<Option<PathBuf>, String> {
    locations
        .get(source)
        .map(|value| {
            value
                .as_str()
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .ok_or_else(|| "Invalid quick launch settings".to_string())
        })
        .transpose()
}

/// A saved choice always wins; otherwise the first default that exists is used.
pub fn resolve(saved: Option<PathBuf>, defaults: Vec<PathBuf>) -> Option<PathBuf> {
    saved.or_else(|| defaults.into_iter().find(|path| path.is_file()))
}

/// Executables are started directly in their own folder; shortcuts and bundles go through the shell.
pub fn starts_directly(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

pub fn open_error(path: &Path, error: impl Display) -> String {
    format!(
        "Could not open {}: {error}. Use Change location to select the app.",
        path.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_choices_are_stored_per_source_and_override_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("config").join("quick-launch.json");
        assert!(read_locations(&settings).unwrap().is_empty());

        let default = dir.path().join("default.exe");
        fs::write(&default, "").unwrap();
        assert_eq!(resolve(None, vec![default.clone()]), Some(default.clone()));
        assert_eq!(resolve(None, vec![dir.path().join("missing.exe")]), None);

        save_location(&settings, "premier", "custom.exe").unwrap();
        let locations = read_locations(&settings).unwrap();
        assert_eq!(
            saved_location(&locations, "premier").unwrap(),
            Some(PathBuf::from("custom.exe"))
        );
        assert_eq!(saved_location(&locations, "gspro").unwrap(), None);
        assert_eq!(
            resolve(
                saved_location(&locations, "premier").unwrap(),
                vec![default.clone()]
            ),
            Some(PathBuf::from("custom.exe"))
        );

        save_location(&settings, "gspro", "other.exe").unwrap();
        let locations = read_locations(&settings).unwrap();
        assert_eq!(locations["premier"], "custom.exe");
        assert_eq!(locations["gspro"], "other.exe");
    }

    #[test]
    fn invalid_input_and_settings_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let settings = dir.path().join("quick-launch.json");
        assert!(save_location(&settings, "other", "app.exe").is_err());
        assert!(save_location(&settings, "gspro", "  ").is_err());
        assert!(!settings.exists());

        fs::write(&settings, r#"{"gspro":123}"#).unwrap();
        let locations = read_locations(&settings).unwrap();
        assert_eq!(
            saved_location(&locations, "gspro").unwrap_err(),
            "Invalid quick launch settings"
        );
        fs::write(&settings, r#"{"gspro":""}"#).unwrap();
        let locations = read_locations(&settings).unwrap();
        assert!(saved_location(&locations, "gspro").is_err());
        fs::write(&settings, "{").unwrap();
        assert!(
            read_locations(&settings)
                .unwrap_err()
                .starts_with("Invalid quick launch settings")
        );
    }

    #[test]
    fn executables_start_directly_and_failures_explain_the_fix() {
        assert!(starts_directly(Path::new("GSPconnect.EXE")));
        assert!(!starts_directly(Path::new("Premier.lnk")));
        assert!(!starts_directly(Path::new("Premier.app")));
        let message = open_error(Path::new("missing.exe"), "not found");
        assert!(message.contains("missing.exe"));
        assert!(message.contains("not found"));
        assert!(message.contains("Change location"));
    }
}
