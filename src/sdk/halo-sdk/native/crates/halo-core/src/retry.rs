use chrono::{Local, NaiveDateTime, TimeZone};
use regex::Regex;
use std::sync::OnceLock;

pub const MAX_RETRIES: u32 = 10;
pub const MAX_RETRY_AFTER_MS: f64 = 60_000.0;

pub fn delay(initial_delay_ms: f64, max_delay_ms: f64, multiplier: f64, attempt: f64, random: f64) -> f64 {
    let base=initial_delay_ms*multiplier.powf(attempt);
    (base+base*0.1*random).min(max_delay_ms)
}

pub fn delay_for_attempt(attempt: u32) -> f64 {
    let random=u32::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..4].try_into().unwrap()) as f64/(u32::MAX as f64+1.0);
    delay(1000.0,60_000.0,2.0,attempt as f64,random)
}

pub fn retryable_status(status: u16) -> bool {
    matches!(status,408|409|429|529|500..=599)
}

pub fn parse_retry_after_ms(value: &str, now_ms: i64) -> Option<f64> {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    let pattern=NUMBER.get_or_init(||Regex::new(r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)").unwrap());
    if let Some(number)=pattern.find(crate::js::trim_start_js(value)) {
        let raw=number.as_str();
        let seconds=if raw=="Infinity"||raw=="+Infinity" {Some(f64::INFINITY)}else{raw.parse::<f64>().ok()};
        if let Some(seconds)=seconds.filter(|value|*value>0.0) {return Some(seconds.ceil()*1000.0);}
    }
    let value=crate::js::trim_js(value);
    let timestamp=chrono::DateTime::parse_from_rfc2822(value).ok().map(|date|date.timestamp_millis())
        .or_else(||chrono::DateTime::parse_from_rfc3339(value).ok().map(|date|date.timestamp_millis()))
        .or_else(||["%A, %d-%b-%y %H:%M:%S GMT","%a, %d %b %Y %H:%M:%S GMT"].iter().find_map(|format|NaiveDateTime::parse_from_str(value,format).ok().map(|date|date.and_utc().timestamp_millis())))
        .or_else(||["%a %b %e %H:%M:%S %Y","%Y-%m-%dT%H:%M:%S"].iter().find_map(|format|NaiveDateTime::parse_from_str(value,format).ok().and_then(|date|Local.from_local_datetime(&date).earliest()).map(|date|date.timestamp_millis())));
    timestamp.map(|date|(date-now_ms) as f64).filter(|delay|*delay>0.0)
}

pub fn http_retry_delay(attempt:u32,status:u16,hint:Option<&str>,retry_after:Option<&str>,now_ms:i64)->Option<f64>{
    let retry=match hint{Some("true")=>true,Some("false")=>false,_=>retryable_status(status)};
    if !retry{return None;}
    match retry_after.and_then(|value|parse_retry_after_ms(value,now_ms)){
        Some(delay)=>(delay<=MAX_RETRY_AFTER_MS).then_some(delay),
        None=>Some(delay_for_attempt(attempt)),
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn retries_keep_the_original_budget_and_positive_jitter(){
        assert_eq!(delay(1000.,60000.,2.,0.,0.),1000.);
        assert_eq!(delay(1000.,60000.,2.,0.,0.5),1050.);
        assert_eq!(delay(1000.,60000.,2.,7.,0.9),60000.);
        assert_eq!(MAX_RETRIES,10);
    }
    #[test]
    fn retry_after_uses_javascript_parse_float_prefix_and_server_hint(){
        assert_eq!(parse_retry_after_ms("1e",0),Some(1000.));
        assert_eq!(parse_retry_after_ms(".001 trailing",0),Some(1000.));
        assert_eq!(http_retry_delay(0,429,Some("false"),None,0),None);
        assert_eq!(http_retry_delay(0,400,Some("true"),Some("2"),0),Some(2000.));
        assert_eq!(http_retry_delay(0,500,None,Some("Infinity"),0),None);
        assert_eq!(parse_retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT",1445412479000),Some(1000.));
    }
    #[test]
    fn classifies_retryable_statuses_and_retry_header_refusals(){
        for status in [408,409,429,529,500,502,503,504,599]{assert!(retryable_status(status),"status {status}");}
        for status in [400,401,403,404,422,499,600]{assert!(!retryable_status(status),"status {status}");}
        assert_eq!(http_retry_delay(0,400,None,None,0),None);
        assert_eq!(http_retry_delay(0,400,Some("false"),Some("2"),0),None);
        assert_eq!(http_retry_delay(0,400,Some("true"),Some("2"),0),Some(2000.));
        assert_eq!(http_retry_delay(0,429,None,Some("7"),0),Some(7000.));
        assert_eq!(http_retry_delay(0,500,None,Some("3600"),0),None);
        assert_eq!(http_retry_delay(0,500,None,Some("0"),0).map(|delay|delay>0.),Some(true));
        assert_eq!(http_retry_delay(0,500,None,None,0).map(|delay|delay>0.),Some(true));
    }
    #[test]
    fn retry_after_zero_and_past_dates_fall_back_to_jitter(){
        assert_eq!(parse_retry_after_ms("0",0),None);
        assert_eq!(parse_retry_after_ms("-1",0),None);
        assert_eq!(parse_retry_after_ms("Wed, 21 Oct 2015 07:28:00 GMT",1445412479000+2000),None);
    }
}
