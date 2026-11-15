//! Reference lab for the openDrum engines: reads the 808 and 909 reference hits, measures them with the report
//! card measures and (later) fits the engines against them. Dev only, never built for the browser.

pub mod engine_fit;
pub mod fft;
pub mod fit;
pub mod measure;
pub mod references;
pub mod wav;
