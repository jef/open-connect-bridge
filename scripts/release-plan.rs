use std::{env, process::Command};

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Bump {
    Patch,
    Minor,
    Major,
}

fn classify(message: &str) -> Option<Bump> {
    let subject = message.trim_start_matches('\n').lines().next()?.trim();
    let (header, description) = subject.split_once(": ")?;
    if description.trim().is_empty() {
        return None;
    }
    let breaking = header.ends_with('!');
    let header = header.strip_suffix('!').unwrap_or(header);
    let kind = header.split('(').next()?;
    if kind.is_empty() || !kind.bytes().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    if header != kind && !(header.starts_with(&format!("{kind}(")) && header.ends_with(')')) {
        return None;
    }
    if breaking
        || message.lines().any(|line| {
            line.starts_with("BREAKING CHANGE:") || line.starts_with("BREAKING-CHANGE:")
        })
    {
        Some(Bump::Major)
    } else if kind == "feat" {
        Some(Bump::Minor)
    } else {
        Some(Bump::Patch)
    }
}

fn next_version(tag: Option<&str>, messages: &str) -> Result<Option<String>, String> {
    let bump = messages.split('\0').filter_map(classify).max();
    let Some(bump) = bump else {
        return Ok(None);
    };
    let Some(tag) = tag else {
        return Ok(Some("1.0.0".into()));
    };
    let parts: Vec<_> = tag
        .strip_prefix('v')
        .ok_or("Tag must start with v")?
        .split('.')
        .collect();
    if parts.len() != 3 {
        return Err(format!("Invalid release tag: {tag}"));
    }
    let numbers: Vec<u64> = parts
        .iter()
        .map(|n| n.parse().map_err(|_| format!("Invalid release tag: {tag}")))
        .collect::<Result<_, _>>()?;
    let (major, minor, patch) = (numbers[0], numbers[1], numbers[2]);
    let increment = |n: u64| {
        n.checked_add(1)
            .ok_or("Version number overflow".to_string())
    };
    Ok(Some(match bump {
        Bump::Major => format!("{}.0.0", increment(major)?),
        Bump::Minor => format!("{major}.{}.0", increment(minor)?),
        Bump::Patch => format!("{major}.{minor}.{}", increment(patch)?),
    }))
}

fn git(args: &[&str]) -> Result<String, String> {
    let result = Command::new("git")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !result.status.success() {
        return Err(format!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    String::from_utf8(result.stdout).map_err(|e| e.to_string())
}

fn main() -> Result<(), String> {
    let tags = git(&["tag", "--merged", "HEAD", "--list", "v[0-9]*"])?;
    let tag = if tags.trim().is_empty() {
        None
    } else {
        Some(
            git(&[
                "describe",
                "--tags",
                "--abbrev=0",
                "--match",
                "v[0-9]*",
                "HEAD",
            ])?
            .trim()
            .to_owned(),
        )
    };
    let range = tag
        .as_ref()
        .map(|tag| format!("{tag}..HEAD"))
        .unwrap_or_else(|| "HEAD".into());
    let messages = git(&["log", "--format=%B%x00", &range])?;
    if let Some(version) = next_version(tag.as_deref(), &messages)? {
        println!("{version}");
    }
    if env::args().len() > 1 {
        return Err("This command takes no arguments".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_follow_conventional_commits() {
        assert_eq!(
            next_version(None, "feat: first\0").unwrap(),
            Some("1.0.0".into())
        );
        assert_eq!(
            next_version(Some("v1.0.0"), "fix: repair\0feat(ui): add\0").unwrap(),
            Some("1.1.0".into())
        );
        assert_eq!(
            next_version(Some("v1.0.0"), "fix: repair\0\nfeat(ui): add\0").unwrap(),
            Some("1.1.0".into())
        );
        assert_eq!(
            next_version(Some("v1.2.3"), "docs: update\0").unwrap(),
            Some("1.2.4".into())
        );
        assert_eq!(
            next_version(Some("v1.2.3"), "feat!: overhaul\0").unwrap(),
            Some("2.0.0".into())
        );
        assert_eq!(
            next_version(Some("v1.2.3"), "fix: change\n\nBREAKING CHANGE: api\0").unwrap(),
            Some("2.0.0".into())
        );
        assert_eq!(
            next_version(Some("v1.2.3"), "non conventional\0").unwrap(),
            None
        );
        assert!(next_version(Some("v1.2"), "fix: change\0").is_err());
    }
}
