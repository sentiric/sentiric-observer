use regex::Regex;
use lazy_static::lazy_static;

lazy_static! {
    static ref CALL_ID_REGEX: Regex = Regex::new(r"(?i)Call-ID:\s*([^\s\r\n]+)").unwrap();
}

// Artık kullanılıyor, 'allow' kaldırıldı.
pub fn clean_ansi(text: &str) -> String {
    let re = Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
    re.replace_all(text, "").trim().to_string()
}

pub fn extract_call_id(text: &str) -> Option<String> {
    CALL_ID_REGEX.captures(text).map(|cap| cap[1].to_string())
}

pub fn try_parse_json(text: &str) -> Option<serde_json::Value> {
    serde_json::from_str(text).ok()
}