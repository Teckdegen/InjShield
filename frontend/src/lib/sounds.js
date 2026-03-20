/**
 * InjShield sound effects — generated via Web Audio API.
 * No external files needed. Plays on user-gesture events (safe for browsers).
 */

function ctx() {
  return new (window.AudioContext || window.webkitAudioContext)();
}

function tone(ac, freq, startTime, duration, volume = 0.12, type = "sine") {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

/** Shield: ascending arpeggio — "locking in" */
export function playShield() {
  try {
    const ac = ctx();
    // C5 → E5 → G5 → C6
    [523, 659, 784, 1047].forEach((f, i) =>
      tone(ac, f, ac.currentTime + i * 0.09, 0.28, 0.1)
    );
  } catch {}
}

/** Unshield: descending arpeggio — "releasing" */
export function playUnshield() {
  try {
    const ac = ctx();
    // C6 → G5 → E5 → C5
    [1047, 784, 659, 523].forEach((f, i) =>
      tone(ac, f, ac.currentTime + i * 0.09, 0.28, 0.1)
    );
  } catch {}
}

/** Regular send: short forward swoosh */
export function playSend() {
  try {
    const ac = ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(700, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, ac.currentTime + 0.35);
    gain.gain.setValueAtTime(0.12, ac.currentTime);
    gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.35);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime + 0.4);
  } catch {}
}

/** Private send: mysterious double-tone swoosh */
export function playPrivateSend() {
  try {
    const ac = ctx();
    // Low rumble + high whoosh
    [[400, 200], [900, 300]].forEach(([start, end], i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.connect(gain);
      gain.connect(ac.destination);
      osc.type = i === 0 ? "triangle" : "sine";
      osc.frequency.setValueAtTime(start, ac.currentTime + i * 0.05);
      osc.frequency.exponentialRampToValueAtTime(end, ac.currentTime + 0.4);
      gain.gain.setValueAtTime(0.08, ac.currentTime + i * 0.05);
      gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.45);
      osc.start(ac.currentTime + i * 0.05);
      osc.stop(ac.currentTime + 0.5);
    });
  } catch {}
}

/** Claim: happy rising chime */
export function playClaim() {
  try {
    const ac = ctx();
    // E5 → G#5 → B5 → E6
    [659, 830, 988, 1319].forEach((f, i) =>
      tone(ac, f, ac.currentTime + i * 0.1, 0.3, 0.09)
    );
  } catch {}
}

/** Error: subtle low buzz */
export function playError() {
  try {
    const ac = ctx();
    tone(ac, 180, ac.currentTime, 0.25, 0.1, "sawtooth");
  } catch {}
}
