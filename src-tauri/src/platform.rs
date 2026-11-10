use std::path::{Path, PathBuf};

const GSPRO_APP: &str = r"C:\GSProV1\Core\GSPC\GSPconnect.exe";
const GSPRO_LOG: &str = r"C:\GSProV1\Core\GSPC\ConnectDebug.txt";

/// GSPconnect and Foresight Premier only exist on Windows, so other platforms
/// have no known locations and the user chooses them in the app.
pub fn default_source_files(windows: bool, home: Option<&Path>) -> (String, String) {
    if !windows {
        return (String::new(), String::new());
    }
    let history = home
        .map(|home| {
            home.join("AppData")
                .join("LocalLow")
                .join("Foresight Sports")
                .join("Foresight Premier")
                .join("ShotReplay")
                .join("history.json")
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_default();
    (GSPRO_LOG.into(), history)
}

pub fn default_app_locations(
    source: &str,
    windows: bool,
    program_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Vec<PathBuf> {
    if !windows {
        return Vec::new();
    }
    if source == "gspro" {
        return vec![PathBuf::from(GSPRO_APP)];
    }
    let mut locations = Vec::new();
    if let Some(base) = program_data {
        locations.push(
            base.join("Microsoft")
                .join("Windows")
                .join("Start Menu")
                .join("Programs")
                .join("Foresight Premier")
                .join("Foresight Premier.lnk"),
        );
    }
    if let Some(base) = program_files {
        locations.push(base.join("Foresight Premier").join("ForesightPremier.exe"));
    }
    locations
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_defaults_use_known_locations() {
        let data = Path::new("C:\\ProgramData");
        let files = Path::new("C:\\Program Files");
        assert_eq!(
            default_app_locations("gspro", true, Some(data), Some(files)),
            [PathBuf::from(GSPRO_APP)]
        );
        assert_eq!(
            default_app_locations("premier", true, Some(data), Some(files)),
            [
                data.join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
                    .join("Foresight Premier")
                    .join("Foresight Premier.lnk"),
                files.join("Foresight Premier").join("ForesightPremier.exe"),
            ]
        );
        assert_eq!(
            default_app_locations("premier", true, None, Some(files)).len(),
            1
        );
        let (log, history) = default_source_files(true, Some(Path::new("C:\\Users\\golfer")));
        assert_eq!(log, GSPRO_LOG);
        assert!(history.starts_with("C:\\Users\\golfer"));
        assert!(history.ends_with("history.json"));
    }

    #[test]
    fn other_platforms_have_no_defaults() {
        let home = Some(Path::new("/home/golfer"));
        assert!(default_app_locations("gspro", false, home, home).is_empty());
        assert!(default_app_locations("premier", false, home, home).is_empty());
        assert_eq!(
            default_source_files(false, home),
            (String::new(), String::new())
        );
    }
}
