/**
 * 字幕解析模块 - SRT/VTT 解析 + 时间同步
 */
export function parseSRT(content) {
  const blocks = content.trim().replace(/\r\n/g, '\n').split('\n\n');
  const subs = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;
    const id = parseInt(lines[0], 10);
    if (isNaN(id)) continue;
    const m = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) continue;
    const start = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
    const end = +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000;
    const text = lines.slice(2).join('\n').replace(/<[^>]+>/g, '').trim();
    subs.push({ id, start, end, text, words: text.split(/\s+/).filter(w=>w) });
  }
  return subs;
}

export function parseVTT(content) {
  const body = content.replace(/^WEBVTT.*\n(?:\n)?/, '').trim();
  const blocks = body.split('\n\n');
  const subs = [];
  let id = 0;
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let ti = 0;
    for (let i=0; i<lines.length; i++) { if (lines[i].includes('-->')) { ti=i; break; } }
    if (!lines[ti]?.includes('-->')) continue;
    const m = lines[ti].match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{3})/);
    if (!m) continue;
    const start = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
    const end = +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000;
    const text = lines.slice(ti+1).join('\n').replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim();
    id++;
    subs.push({ id, start, end, text, words: text.split(/\s+/).filter(w=>w) });
  }
  return subs;
}

export function parseSubtitle(content, filename='') {
  if (filename.endsWith('.vtt') || content.trim().startsWith('WEBVTT')) return parseVTT(content);
  return parseSRT(content);
}

export function findCurrentSubtitle(subs, currentTime) {
  for (const s of subs) { if (currentTime >= s.start && currentTime <= s.end) return s; }
  return null;
}

export function formatTime(s) {
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60), ms=Math.floor((s%1)*1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(3,'0')}`;
}
