//! Lyrics: LRC parsing and source resolution, feeding the degradation
//! ladder (PRODUCT.md): word-synced → line-synced → static → none.
//! Every rung is a complete experience; the ladder is data (`kind`),
//! rendering policy stays in the UI.
//!
//! Source priority: embedded tag → sidecar `.lrc`. Online providers are
//! a later cut and will write sidecars with provenance `agent`, never
//! silently embed (PRODUCT.md).

use std::path::Path;

use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LyricsKind {
    WordSynced,
    LineSynced,
    Static,
}

#[derive(Debug, Serialize)]
pub struct Word {
    pub time_ms: u64,
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct Line {
    pub time_ms: u64,
    pub text: String,
    /// Present only on word-synced lines (enhanced LRC).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<Word>>,
}

#[derive(Debug, Serialize)]
pub struct LyricsDoc {
    pub kind: LyricsKind,
    /// Where the lyrics came from: "embedded" | "sidecar".
    pub source: &'static str,
    pub lines: Vec<Line>,
}

/// Find lyrics for an audio file: embedded tag first, then a sidecar
/// `.lrc` next to it. `Ok(None)` when there are none — spectrum takes
/// the whole stage.
pub fn resolve(audio: &Path) -> Result<Option<LyricsDoc>, lofty::error::LoftyError> {
    let tagged = lofty::read_from_path(audio)?;
    if let Some(text) = tagged
        .primary_tag()
        .or_else(|| tagged.first_tag())
        // USLT maps to UnsyncLyrics in lofty; Lyrics covers other formats.
        .and_then(|t| {
            t.get_string(ItemKey::UnsyncLyrics)
                .or_else(|| t.get_string(ItemKey::Lyrics))
        })
    {
        let mut doc = parse_lrc(text);
        doc.source = "embedded";
        return Ok(Some(doc));
    }
    let sidecar = audio.with_extension("lrc");
    if let Ok(text) = std::fs::read_to_string(&sidecar) {
        let mut doc = parse_lrc(&text);
        doc.source = "sidecar";
        return Ok(Some(doc));
    }
    Ok(None)
}

/// Parse LRC text: standard line timestamps `[mm:ss.xx]` (repeatable),
/// enhanced word tags `<mm:ss.xx>`, `[offset:±ms]`, metadata tags
/// ignored. Untimed non-empty lines make the whole doc `Static`.
pub fn parse_lrc(text: &str) -> LyricsDoc {
    let mut offset_ms: i64 = 0;
    let mut lines: Vec<Line> = Vec::new();
    let mut any_timed = false;
    let mut any_words = false;

    for raw in text.lines() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        if let Some(value) = raw
            .strip_prefix("[offset:")
            .and_then(|r| r.strip_suffix(']'))
        {
            offset_ms = value.trim().trim_start_matches('+').parse().unwrap_or(0);
            continue;
        }

        let (stamps, rest) = leading_timestamps(raw);
        if stamps.is_empty() {
            // Metadata like [ti:...] has no numeric timestamp; skip it.
            // Anything else untimed is static lyric text.
            if !is_metadata_tag(raw) {
                lines.push(Line { time_ms: 0, text: raw.to_string(), words: None });
            }
            continue;
        }
        any_timed = true;
        let words = parse_word_tags(rest);
        let text_joined = match &words {
            Some(ws) => ws.iter().map(|w| w.text.as_str()).collect::<String>().trim_end().to_string(),
            None => rest.trim().to_string(),
        };
        if words.is_some() {
            any_words = true;
        }
        for stamp in stamps {
            lines.push(Line {
                time_ms: apply_offset(stamp, offset_ms),
                text: text_joined.clone(),
                words: words.as_ref().map(|ws| {
                    ws.iter()
                        .map(|w| Word { time_ms: apply_offset(w.time_ms, offset_ms), text: w.text.clone() })
                        .collect()
                }),
            });
        }
    }

    lines.sort_by_key(|l| l.time_ms);
    LyricsDoc {
        kind: if !any_timed {
            LyricsKind::Static
        } else if any_words {
            LyricsKind::WordSynced
        } else {
            LyricsKind::LineSynced
        },
        source: "embedded",
        lines,
    }
}

fn apply_offset(time_ms: u64, offset_ms: i64) -> u64 {
    (time_ms as i64 + offset_ms).max(0) as u64
}

/// Parse `mm:ss`, `mm:ss.x`, `mm:ss.xx`, or `mm:ss.xxx` into ms.
fn parse_timestamp(s: &str) -> Option<u64> {
    let (minutes, rest) = s.split_once(':')?;
    let minutes: u64 = minutes.parse().ok()?;
    let (seconds, ms) = match rest.split_once('.') {
        Some((sec, frac)) => {
            let sec: u64 = sec.parse().ok()?;
            // ".5" = 500ms, ".50" = 500ms, ".500" = 500ms
            let frac_ms: u64 = frac.parse().ok()?;
            let scale = match frac.len() {
                1 => 100,
                2 => 10,
                3 => 1,
                _ => return None,
            };
            (sec, frac_ms * scale)
        }
        None => (rest.parse().ok()?, 0),
    };
    if seconds >= 60 {
        return None;
    }
    Some(minutes * 60_000 + seconds * 1_000 + ms)
}

/// Consume every `[timestamp]` at line start; return them + the rest.
fn leading_timestamps(line: &str) -> (Vec<u64>, &str) {
    let mut stamps = Vec::new();
    let mut rest = line;
    while let Some(inner) = rest.strip_prefix('[') {
        let Some((body, after)) = inner.split_once(']') else { break };
        let Some(ms) = parse_timestamp(body) else { break };
        stamps.push(ms);
        rest = after;
    }
    (stamps, rest)
}

/// Enhanced LRC: `<mm:ss.xx>word ` word tags within a line.
fn parse_word_tags(rest: &str) -> Option<Vec<Word>> {
    if !rest.trim_start().starts_with('<') {
        return None;
    }
    let mut words = Vec::new();
    for segment in rest.trim_start().split('<').filter(|s| !s.is_empty()) {
        let (stamp, text) = segment.split_once('>')?;
        words.push(Word { time_ms: parse_timestamp(stamp)?, text: text.to_string() });
    }
    if words.is_empty() {
        None
    } else {
        Some(words)
    }
}

fn is_metadata_tag(line: &str) -> bool {
    line.starts_with('[')
        && line.ends_with(']')
        && line[1..].split_once(':').is_some_and(|(key, _)| {
            !key.is_empty() && key.chars().all(|c| c.is_ascii_alphabetic())
        })
}
