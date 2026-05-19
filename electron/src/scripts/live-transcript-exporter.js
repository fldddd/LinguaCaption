/**
 * LinguaCaption - Live Transcript Exporter Module
 * Export transcription segments to SRT, TXT, JSON formats
 */

/**
 * Parse time string (MM:SS) to seconds
 * @param {string} timeStr
 * @returns {number}
 */
export function parseTimeToSeconds(timeStr) {
  const parts = timeStr.split(":");
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

/**
 * Format seconds to SRT time format (HH:MM:SS,000)
 * @param {number} seconds
 * @returns {string}
 */
export function secondsToSrtTime(seconds) {
  const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${h}:${m}:${s},000`;
}

/**
 * Generate SRT format content from segments
 * @param {Array} allSegments
 * @returns {string}
 */
export function generateSRT(allSegments) {
  return allSegments.map((seg, index) => {
    const startTime = secondsToSrtTime(parseTimeToSeconds(seg.time));
    const endTime = secondsToSrtTime(parseTimeToSeconds(seg.time) + 5);
    return `${index + 1}\n${startTime} --> ${endTime}\n${seg.text}\n`;
  }).join("\n");
}

/**
 * Export transcript in specified format
 * @param {string} format - "srt", "txt", or "json"
 * @param {Array} allSegments
 * @param {Function} showToast - toast notification function
 */
export function exportTranscript(format, allSegments, showToast) {
  if (allSegments.length === 0) {
    showToast("没有可导出的内容", "warning");
    return;
  }

  let content, filename, mimeType;

  switch (format) {
    case "srt":
      content = generateSRT(allSegments);
      filename = `transcript_${Date.now()}.srt`;
      mimeType = "text/plain";
      break;
    case "txt":
      content = allSegments.map(s => `[${s.time}] ${s.text}`).join("\n");
      filename = `transcript_${Date.now()}.txt`;
      mimeType = "text/plain";
      break;
    case "json":
      content = JSON.stringify({
        segments: allSegments,
        exportedAt: new Date().toISOString(),
        totalSegments: allSegments.length,
      }, null, 2);
      filename = `transcript_${Date.now()}.json`;
      mimeType = "application/json";
      break;
    default:
      return;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);

  showToast(`已导出 ${format.toUpperCase()}`, "success");
}
