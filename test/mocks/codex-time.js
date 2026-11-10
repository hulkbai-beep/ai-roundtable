'use strict';
// codex 写恢复时间的格式（codex-rs/protocol/src/error.rs 的 format_retry_timestamp）：
// 当天写 “3:05 PM”，不是当天写 “Jan 2nd, 2026 3:05 PM”。模拟的 codex 和测试都用它。
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function codexRetryTime(ts, now = Date.now()) {
  const d = new Date(ts);
  const hm = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  if (d.toDateString() === new Date(now).toDateString()) return hm;
  const day = d.getDate();
  const suffix = day >= 11 && day <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[day % 10] || 'th';
  return `${MONTHS[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()} ${hm}`;
}

module.exports = { codexRetryTime };
