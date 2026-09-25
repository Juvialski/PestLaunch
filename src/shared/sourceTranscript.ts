import type { TranscriptSegment } from "./calls.js";

export type SourceTranscriptDisplaySegment = {
  speaker: string;
  timestamp: string | null;
  text: string;
};

export function buildSourceTranscriptDisplay(segments: TranscriptSegment[]): SourceTranscriptDisplaySegment[] {
  return segments.map((segment) => ({
    speaker: formatSourceSpeaker(segment.speaker),
    timestamp: formatSegmentTime(segment.startMs, segment.endMs),
    text: segment.text,
  }));
}

export function formatSourceSpeaker(speaker: string): string {
  const speakerNumber = /^spk:(\d+)$/i.exec(speaker.trim());
  return speakerNumber ? `Speaker ${Number(speakerNumber[1]) + 1}` : speaker;
}

function formatSegmentTime(startMs?: number, endMs?: number): string | null {
  const format = (value: number) => {
    const totalSeconds = Math.floor(value / 1_000);
    return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
  };
  if (startMs === undefined) return endMs === undefined ? null : format(endMs);
  if (endMs === undefined) return format(startMs);
  return `${format(startMs)}–${format(endMs)}`;
}
