pub const PARAMS: usize = 16;

/// The sound parameters a lane can move. Tune and Volume belong to the device, not to a pattern.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Param {
    Ratio1,
    Feedback,
    Ratio2,
    Depth2,
    Wave,
    Depth,
    Strike,
    StrikeDecay,
    Fold,
    FoldPlace,
    Length,
    HeldShare,
    SineLevel,
    SinePitch,
    Glide,
    Velocity
}

#[derive(Clone, Copy, Debug)]
pub struct Range {
    pub min: f32,
    pub max: f32,
    pub exponential: bool
}

impl Range {
    const fn linear(min: f32, max: f32) -> Self {Self {min, max, exponential: false}}
    const fn exponential(min: f32, max: f32) -> Self {Self {min, max, exponential: true}}

    pub fn value(&self, unit: f32) -> f32 {
        if self.exponential {self.min * libm::powf(self.max / self.min, unit)} else {self.min + (self.max - self.min) * unit}
    }

    pub fn unit(&self, value: f32) -> f32 {
        if self.exponential {libm::logf(value / self.min) / libm::logf(self.max / self.min)} else {(value - self.min) / (self.max - self.min)}
    }
}

impl Param {
    pub const ALL: [Param; PARAMS] = [
        Param::Ratio1, Param::Feedback, Param::Ratio2, Param::Depth2, Param::Wave, Param::Depth, Param::Strike, Param::StrikeDecay,
        Param::Fold, Param::FoldPlace, Param::Length, Param::HeldShare, Param::SineLevel, Param::SinePitch, Param::Glide, Param::Velocity
    ];

    pub fn range(self) -> Range {
        match self {
            Param::Ratio1 => Range::exponential(0.25, 8.0),
            Param::Ratio2 => Range::exponential(0.25, 16.0),
            Param::Depth2 => Range::linear(0.0, 1.5),
            Param::Depth => Range::linear(0.0, 4.0),
            Param::Strike => Range::linear(0.0, 8.0),
            Param::StrikeDecay => Range::exponential(0.02, 1.0),
            Param::SineLevel => Range::linear(0.0, 1.5),
            Param::Glide => Range::linear(0.0, 0.3),
            Param::Wave => Range::linear(0.0, 4.0),
            Param::FoldPlace | Param::SinePitch => Range::linear(0.0, 2.0),
            Param::Feedback | Param::Fold | Param::Length | Param::HeldShare | Param::Velocity => Range::linear(0.0, 1.0)
        }
    }

    pub fn is_switch(self) -> bool {matches!(self, Param::Wave | Param::FoldPlace | Param::SinePitch)}
}
