// The village's sound: square and triangle waves through WebAudio, nothing recorded.
// Browsers only allow sound after the player has clicked or pressed something, so `unlock`
// is called from the "Walk in" button.

let audio = null;
let master = null;
let muted = false;
try {
  muted = localStorage.getItem('village-muted') === '1';
} catch {
  /* storage can be blocked */
}

export function unlock() {
  if (audio) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    audio = new AudioContext();
    master = audio.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(audio.destination);
  } catch {
    audio = null;
  }
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem('village-muted', value ? '1' : '0');
  } catch {
    /* fine */
  }
  if (master) master.gain.value = muted ? 0 : 0.5;
}

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// "E4", "C#5", "Bb3" -> frequency in Hz; "R" (a rest) -> null.
function pitch(name) {
  const found = /^([A-G])([#b]?)(\d)$/.exec(name);
  if (!found) return null;
  const midi = 12 * (Number(found[3]) + 1) + SEMITONES[found[1]] + (found[2] === '#' ? 1 : found[2] === 'b' ? -1 : 0);
  return 440 * 2 ** ((midi - 69) / 12);
}

function tone(frequency, at, length, { type = 'square', volume = 0.12 } = {}) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.012);
  gain.gain.setValueAtTime(volume, at + Math.max(0.02, length * 0.6));
  gain.gain.exponentialRampToValueAtTime(0.0008, at + length);
  oscillator.connect(gain);
  gain.connect(master);
  oscillator.start(at);
  oscillator.stop(at + length + 0.02);
}

// How long a tune lasts, in seconds, whether or not anything can be heard.
export function tuneSeconds(notes, beat = 0.2) {
  return notes.reduce((total, token) => total + (Number(token.split(':')[1]) || 1) * beat, 0);
}

// Play a list of notes like ["E4", "G4", "A4:2", "R"]. Returns the tune's length in seconds.
export function playTune(notes, beat = 0.2) {
  const total = tuneSeconds(notes, beat);
  if (!audio || muted) return total;
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  let at = audio.currentTime + 0.06;
  for (const token of notes) {
    const [name, hold] = token.split(':');
    const length = (Number(hold) || 1) * beat;
    const frequency = pitch(name);
    if (frequency) {
      tone(frequency, at, length * 0.95);
      tone(frequency / 2, at, length * 0.95, { type: 'triangle', volume: 0.1 }); // a soft octave below
    }
    at += length;
  }
  return total;
}

const JINGLES = {
  wake: [['C5', 0.07], ['E5', 0.07], ['G5', 0.07], ['C6', 0.14]], // a sandbox came up
  sleep: [['G5', 0.08], ['E5', 0.08], ['C5', 0.16]], // snapshot taken, sandbox gone
  post: [['A5', 0.06], ['E6', 0.1]], // a letter set off
  crash: [['C3', 0.1], ['B2', 0.1], ['A2', 0.24]], // a house fell down
  spell: [['E5', 0.06], ['G#5', 0.06], ['B5', 0.06], ['E6', 0.06], ['B5', 0.06], ['E6', 0.2]], // the weather changed
  build: [['C4', 0.06], ['G4', 0.06], ['C5', 0.12]], // something new stands in the village
  bell: [['E5', 0.22], ['C5', 0.34]], // the watchman put somebody to bed
  door: [['G3', 0.05], ['D4', 0.07]], // in or out of a house
  hello: [['E5', 0.05], ['A5', 0.08]], // a conversation opens
  tick: [['A5', 0.05], ['E6', 0.05], ['A6', 0.12]], // one more thing in the almanac done
  gift: [['C5', 0.07], ['E5', 0.07], ['G5', 0.07], ['C6', 0.07], ['E6', 0.22]], // you were handed something
};

// One letter of somebody talking: very short, very quiet, a little off pitch each time.
export function blip(frequency, type = 'square') {
  if (!audio || muted) return;
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  tone(frequency * (0.94 + Math.random() * 0.12), audio.currentTime + 0.005, 0.045, { type, volume: type === 'square' ? 0.03 : 0.06 });
}

// A short effect by name. Quiet on purpose: these go off whenever any sandbox changes state.
export function jingle(name) {
  const notes = JINGLES[name];
  if (!notes || !audio || muted) return;
  if (audio.state === 'suspended') audio.resume().catch(() => {});
  let at = audio.currentTime + 0.02;
  for (const [note, length] of notes) {
    tone(pitch(note), at, length, { volume: 0.07 });
    at += length;
  }
}
