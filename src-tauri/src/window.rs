/// Height in physical pixels that fits the content without exceeding the display work area.
pub fn fit_height(desired: u32, frame: u32, work_area: u32) -> u32 {
    desired.min(work_area.saturating_sub(frame)).max(1)
}

/// Moves a window up only as far as needed to keep it within the display work area.
pub fn clamp_y(y: i32, outer_height: u32, area_y: i32, area_height: u32) -> i32 {
    let max_y = i64::from(area_y) + i64::from(area_height) - i64::from(outer_height);
    i64::from(y).min(max_y).max(i64::from(area_y)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_fits_content_and_is_limited_to_the_work_area() {
        assert_eq!(fit_height(701, 39, 1080), 701);
        assert_eq!(fit_height(1200, 39, 1080), 1041);
        assert_eq!(fit_height(700, 39, 39), 1);
        assert_eq!(fit_height(700, 100, 39), 1);
    }

    #[test]
    fn position_stays_inside_the_work_area() {
        assert_eq!(clamp_y(100, 800, 0, 1040), 100);
        assert_eq!(clamp_y(500, 800, 0, 1040), 240);
        assert_eq!(clamp_y(-50, 800, 0, 1040), 0);
        assert_eq!(clamp_y(10, 800, 40, 1040), 40);
        assert_eq!(clamp_y(300, 1200, 0, 1040), 0);
    }
}
