//! Euclidean rhythms: pulses spread over steps by Bjorklund's algorithm (the rhythms of Toussaint's paper), and
//! accents and bursts spread the same way over a lane's hits.

pub const MAX_STEPS: usize = 32;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
pub struct Step {
    pub hit: bool,
    pub accent: bool,
    pub burst: bool
}

/// `pulses` over `steps` (both clamped to `1..=MAX_STEPS` and `0..=steps`), the first on step 0 before `rotate`
/// shifts them right.
pub fn spread(steps: i32, pulses: i32, rotate: i32) -> ([bool; MAX_STEPS], usize) {
    let length = steps.clamp(1, MAX_STEPS as i32) as usize;
    let count = pulses.clamp(0, length as i32) as usize;
    let mut even = [false; MAX_STEPS];
    bjorklund(length, count, &mut even);
    let offset = rotate.rem_euclid(length as i32) as usize;
    let mut rotated = [false; MAX_STEPS];
    for index in 0..length {rotated[index] = even[(index + length - offset) % length];}
    (rotated, length)
}

// groups of [hit] and [rest] merged pairwise until at most one rest group is left
fn bjorklund(steps: usize, pulses: usize, out: &mut [bool; MAX_STEPS]) {
    if pulses == 0 {return;}
    // every group as (start, length) into a flat pattern, rebuilt each round
    let mut pattern = [false; MAX_STEPS];
    let mut groups = [(0usize, 0usize); MAX_STEPS];
    for index in 0..steps {
        pattern[index] = index < pulses;
        groups[index] = (index, 1);
    }
    let mut heads = pulses;
    let mut tails = steps - pulses;
    while tails > 1 {
        let count = heads.min(tails);
        let mut merged = [false; MAX_STEPS];
        let mut next = [(0usize, 0usize); MAX_STEPS];
        let mut written = 0;
        let put = |merged: &mut [bool; MAX_STEPS], written: &mut usize, (start, length): (usize, usize)| {
            merged[*written..*written + length].copy_from_slice(&pattern[start..start + length]);
            *written += length;
        };
        let mut total = 0;
        for index in 0..count {
            let begin = written;
            put(&mut merged, &mut written, groups[index]);
            put(&mut merged, &mut written, groups[heads + index]);
            next[total] = (begin, written - begin);
            total += 1;
        }
        let rest = if heads > count {count..heads} else {heads + count..heads + tails};
        let remainder = rest.len();
        for index in rest {
            let begin = written;
            put(&mut merged, &mut written, groups[index]);
            next[total] = (begin, written - begin);
            total += 1;
        }
        pattern = merged;
        groups = next;
        heads = count;
        tails = remainder;
    }
    out[..steps].copy_from_slice(&pattern[..steps]);
}

/// Every step of a lane, its accents and bursts spread over its hits the way the hits spread over the steps.
#[allow(clippy::too_many_arguments)]
pub fn steps(steps: i32, pulses: i32, rotate: i32, accents: i32, accent_rotate: i32, bursts: i32, burst_rotate: i32)
             -> ([Step; MAX_STEPS], usize) {
    let (hits, length) = spread(steps, pulses, rotate);
    let count = hits[..length].iter().filter(|hit| **hit).count() as i32;
    let (accented, _) = spread(count, accents, accent_rotate);
    let (bursting, _) = spread(count, bursts, burst_rotate);
    let mut out = [Step::default(); MAX_STEPS];
    let mut hit_index = 0;
    for index in 0..length {
        if !hits[index] {continue;}
        out[index] = Step {hit: true, accent: count > 0 && accented[hit_index], burst: count > 0 && bursting[hit_index]};
        hit_index += 1;
    }
    (out, length)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pattern(steps: i32, pulses: i32, rotate: i32) -> String {
        let (hits, length) = spread(steps, pulses, rotate);
        hits[..length].iter().map(|hit| if *hit {'x'} else {'.'}).collect()
    }

    #[test]
    fn spreads_the_rhythms_of_toussaints_paper() {
        assert_eq!(pattern(8, 3, 0), "x..x..x.");
        assert_eq!(pattern(16, 4, 0), "x...x...x...x...");
        assert_eq!(pattern(8, 5, 0), "x.xx.xx.");
        assert_eq!(pattern(9, 4, 0), "x.x.x.x..");
        assert_eq!(pattern(12, 5, 0), "x..x.x..x.x.");
        assert_eq!(pattern(16, 7, 0), "x..x.x.x..x.x.x.");
        assert_eq!(pattern(13, 5, 0), "x..x.x..x.x..");
        assert_eq!(pattern(5, 0, 0), ".....");
        assert_eq!(pattern(4, 9, 0), "xxxx");
    }

    #[test]
    fn rotates_right_and_clamps_the_length() {
        assert_eq!(pattern(8, 3, 1), ".x..x..x");
        assert_eq!(pattern(8, 3, -1), "..x..x.x");
        assert_eq!(pattern(8, 3, 9), ".x..x..x");
        assert_eq!(pattern(0, 1, 0), "x");
        assert_eq!(pattern(40, 0, 0).len(), MAX_STEPS);
    }

    #[test]
    fn spreads_accents_and_bursts_over_the_hits() {
        let (steps, length) = steps(8, 4, 0, 2, 0, 1, 1);
        let picture = |pick: fn(&Step) -> bool| steps[..length].iter().map(|step| if pick(step) {'x'} else {'.'}).collect::<String>();
        assert_eq!(picture(|step| step.hit), "x.x.x.x.");
        assert_eq!(picture(|step| step.accent), "x...x...");
        assert_eq!(picture(|step| step.burst), "..x.....");
    }

    #[test]
    fn more_accents_than_hits_clamp_to_the_hits() {
        let (steps, length) = steps(8, 2, 0, 32, 0, 0, 0);
        assert_eq!(steps[..length].iter().filter(|step| step.accent).count(), 2);
        let (empty, length) = super::steps(4, 0, 0, 3, 0, 3, 0);
        assert!(empty[..length].iter().all(|step| !step.hit && !step.accent && !step.burst));
    }
}
