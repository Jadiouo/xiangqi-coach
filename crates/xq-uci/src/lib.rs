//! Process-facing pieces shared by the `xq-uci` binary and its tests.
//! Spawning an external engine and talking UCI to it lives here, never in `xq-core` or
//! `xq-engine`. The engine is only reached through its executable and the UCI text protocol.

mod uci_analyzer;

pub use uci_analyzer::{AnalysisCancellation, UciAnalyzer, UciError};
