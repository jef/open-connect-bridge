use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "PascalCase")]
pub struct BallData {
    pub speed: f64,
    #[serde(rename = "VLA")]
    pub vla: f64,
    #[serde(rename = "HLA")]
    pub hla: f64,
    pub side_spin: f64,
    pub total_spin: f64,
    pub back_spin: f64,
    pub spin_axis: f64,
}

fn rounded(n: f64) -> f64 {
    (n * 10000.0).round() / 10000.0
}

pub fn gspro(line: &str) -> Option<BallData> {
    let start = line.rfind('[')? + 1;
    let end = line.rfind(']')?;
    let parts: Vec<_> = line.get(start..end)?.split(',').collect();
    if parts.len() != 8 {
        return None;
    }
    let values: Vec<f64> = parts
        .iter()
        .map(|x| x.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .ok()?;
    if values.iter().any(|x| !x.is_finite()) {
        return None;
    }
    Some(BallData {
        speed: rounded(values[0]),
        vla: rounded(values[1]),
        hla: rounded(values[2]),
        side_spin: rounded(values[3]),
        total_spin: rounded(values[4]),
        back_spin: rounded(values[5]),
        spin_axis: rounded(values[6]),
    })
}

pub fn premier(record: &Value) -> Option<BallData> {
    let num = |key| {
        record
            .get(key)?
            .as_f64()
            .filter(|n| n.is_finite() && n.abs() < 1e30)
    };
    let speed = num("ballSpeedMPH")?;
    if speed <= 0.0 {
        return None;
    }
    let side = num("sideSpinRPM").unwrap_or(0.0);
    let back = num("backspinRPM").unwrap_or(0.0);
    Some(BallData {
        speed: rounded(speed),
        vla: rounded(num("launchAngleDeg")?),
        hla: rounded(num("azimuthDeg")?),
        side_spin: rounded(side),
        total_spin: rounded(num("totalSpinRPM").unwrap_or(back.hypot(side))),
        back_spin: rounded(back),
        spin_axis: rounded(num("spinAxisTiltDeg").unwrap_or(0.0)),
    })
}

pub fn message(number: u64, ball: Option<&BallData>) -> Value {
    let mut result = json!({
        "DeviceID": "Foresight GC3", "Units": "Yards", "ShotNumber": number,
        "APIversion": "1",
        "ShotDataOptions": {
            "ContainsBallData": ball.is_some(), "ContainsClubData": false,
            "LaunchMonitorIsReady": true, "LaunchMonitorBallDetected": ball.is_some(),
            "IsHeartBeat": ball.is_none()
        }
    });
    if let Some(ball) = ball {
        result["BallData"] = json!(ball);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_shots_and_heartbeat() {
        let ball = gspro("[82.3337,19.9920921,1.68702,1161,6899.38574,6801,9.687589,0]").unwrap();
        assert_eq!(ball.vla, 19.9921);
        assert_eq!(ball.hla, 1.687);
        assert_eq!(ball.total_spin, 6899.3857);
        assert!(gspro("[1,2,3,4,5,6,7,NaN]").is_none());
        assert!(gspro("[1,2,3]").is_none());
        let shot = message(1, Some(&ball));
        assert_eq!(shot["BallData"]["VLA"], 19.9921);
        assert_eq!(shot["ShotDataOptions"]["ContainsBallData"], true);
        let heartbeat = message(1, None);
        assert!(heartbeat.get("BallData").is_none());
        assert_eq!(heartbeat["ShotDataOptions"]["IsHeartBeat"], true);
    }

    #[test]
    fn maps_premier_and_missing_values() {
        let ball = premier(&json!({"ballSpeedMPH":100,"launchAngleDeg":10,"azimuthDeg":0,"backspinRPM":3,"sideSpinRPM":4})).unwrap();
        assert_eq!(ball.total_spin, 5.0);
        assert_eq!(ball.spin_axis, 0.0);
        assert!(
            premier(&json!({"ballSpeedMPH":1e38,"launchAngleDeg":10,"azimuthDeg":0})).is_none()
        );
    }
}
