// palette.js — the pitch→color mapping, shared by every part of the app that
// colors anything by pitch (HUD unit dots, constellation nodes). One source of
// truth so the whole piece stays visually consistent.

// Plausible human-voice bounds; matches the detector's range in audio.js.
export const PITCH_COLOR_MIN = 70; // Hz
export const PITCH_COLOR_MAX = 500;

// Normalize a pitch onto 0..1 using a LOG scale — pitch perception is
// logarithmic (octaves), so a log mapping spreads typical voices across the
// gradient instead of bunching everyone at the bottom.
export function pitchT(pitchHz) {
  return Math.min(
    1,
    Math.max(
      0,
      (Math.log(pitchHz) - Math.log(PITCH_COLOR_MIN)) /
        (Math.log(PITCH_COLOR_MAX) - Math.log(PITCH_COLOR_MIN))
    )
  );
}

// Low pitch = deep blue, high pitch = bright magenta (hue 220° → 320°),
// with higher pitches also reading brighter.
export function pitchToColor(pitchHz) {
  const t = pitchT(pitchHz);
  const hue = 220 + t * 100;
  const lightness = 45 + t * 25;
  return `hsl(${hue}, 90%, ${lightness}%)`;
}

// Color for units with no detectable pitch (whispers, fricatives, taps):
// a dim neutral gray — they're part of the artwork but visually recessive.
export const UNVOICED_COLOR = '#555';
