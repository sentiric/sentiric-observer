use regex::Regex;
use lazy_static::lazy_static;

lazy_static! {
    // Bu artık kullanılmıyor ancak gelecekte ham SIP ayrıştırma için
    // gerekebilir diye bırakılabilir. Ancak mevcut uyarıyı gidermek adına siliyoruz.
    // static ref CALL_ID_REGEX: Regex = Regex::new(r"(?i)Call-ID:\s*([^\s\r\n]+)").unwrap();
}

// Artık sadece bu fonksiyon kullanılıyor.
pub fn clean_ansi(text: &str) -> String {
    let re = Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
    re.replace_all(text, "").trim().to_string()
}