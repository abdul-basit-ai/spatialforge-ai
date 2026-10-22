"use client";

import { useSyncExternalStore } from "react";

// Browser voice guidance. Plays cached ElevenLabs audio from the server (/api/forge/audio/<key> or /api/forge/tts),
// falling back to speechSynthesis when the server answers 204 (ElevenLabs unavailable) or playback fails.
// Contract: speak(text, {audioUrl}), stopSpeaking(), setVoiceEnabled() (persisted in localStorage).
// Priority: "correction" cuts off whatever is playing (queued step lines play after it); "step" (default) queues
// (max 3, oldest dropped); "info" plays only when idle. {interrupt:true} clears everything and plays now.
export type VoicePriority = "correction" | "step" | "info";
export type SpeakOptions = { audioUrl?: string; priority?: VoicePriority; interrupt?: boolean; rate?: number; volume?: number };

type Item = { text: string; url: string; priority: VoicePriority; rate: number; volume: number; done: () => void };
type Outcome = "ended" | "cancel" | "failed" | "blocked";

const ENABLED_KEY = "forge.voice.enabled";
const OPTIONS_KEY = "forge.voice.options";
const MAX_QUEUE = 3;
const browser = () => typeof window !== "undefined";
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const cleanText = (text: string) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 600);

let initialised = false;
let enabled = true;
let defaults = { rate: 1, volume: 1 };
let queue: Item[] = [];
let current: Item | null = null;
let cancelCurrent: (() => void) | null = null;
let waitingForGesture: Item | null = null;
let unlocked = false;
let player: HTMLAudioElement | null = null;
let snapshot = { enabled: true, speaking: false };
const listeners = new Set<() => void>();

function emit() {
  const next = { enabled, speaking: Boolean(current) };
  if (next.enabled !== snapshot.enabled || next.speaking !== snapshot.speaking) { snapshot = next; listeners.forEach((listener) => listener()); }
}

function readStorage<T>(key: string, fallback: T): T {
  try { const raw = window.localStorage.getItem(key); return raw === null ? fallback : (JSON.parse(raw) as T); } catch { return fallback; }
}
function writeStorage(key: string, value: unknown) { try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } }

// A 0.1 s silent WAV, played inside the first user gesture so mobile browsers let this element play later.
function silentWav() {
  const samples = 800, bytes = new Uint8Array(44 + samples * 2), view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples * 2, true);
  let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `data:audio/wav;base64,${btoa(binary)}`;
}

function getPlayer() {
  if (!player) { player = new Audio(); player.preload = "auto"; (player as HTMLAudioElement & { playsInline?: boolean }).playsInline = true; }
  return player;
}

function unlock() {
  if (unlocked) return;
  unlocked = true;
  for (const type of ["pointerdown", "keydown", "touchend"]) window.removeEventListener(type, unlock, true);
  if (!current) {
    const el = getPlayer(); el.src = silentWav(); el.volume = 0;
    el.play().then(() => el.pause()).catch(() => { /* still locked; real playback will fall back */ });
  }
  try { if ("speechSynthesis" in window && !window.speechSynthesis.speaking) { const warm = new SpeechSynthesisUtterance(" "); warm.volume = 0; window.speechSynthesis.speak(warm); } } catch { /* ignore */ }
  const pending = waitingForGesture; waitingForGesture = null;
  if (pending && enabled) { queue.unshift(pending); pump(); }
}

function init() {
  if (initialised || !browser()) return;
  initialised = true;
  enabled = readStorage<boolean>(ENABLED_KEY, true) !== false;
  const stored = readStorage<Partial<typeof defaults>>(OPTIONS_KEY, {});
  defaults = { rate: clamp(Number(stored.rate) || 1, 0.5, 2), volume: clamp(stored.volume ?? 1, 0, 1) };
  unlocked = Boolean((navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive);
  if (!unlocked) for (const type of ["pointerdown", "keydown", "touchend"]) window.addEventListener(type, unlock, { capture: true, passive: true });
  window.addEventListener("storage", (event) => { if (event.key === ENABLED_KEY) { enabled = readStorage<boolean>(ENABLED_KEY, true) !== false; if (!enabled) stopSpeaking(); emit(); } });
  emit();
}

function playAudio(item: Item): Promise<Outcome> {
  return new Promise((resolve) => {
    const el = getPlayer();
    let settled = false;
    const timer = window.setTimeout(() => finish("failed"), 12000); // never started (slow network or stalled response)
    const onPlaying = () => window.clearTimeout(timer);
    const onEnded = () => finish("ended");
    const onError = () => finish("failed"); // includes the 204 "no ElevenLabs audio" reply
    function finish(outcome: Outcome) {
      if (settled) return; settled = true;
      window.clearTimeout(timer);
      el.removeEventListener("playing", onPlaying); el.removeEventListener("ended", onEnded); el.removeEventListener("error", onError);
      if (outcome !== "ended") el.pause();
      resolve(outcome);
    }
    cancelCurrent = () => finish("cancel");
    el.addEventListener("playing", onPlaying); el.addEventListener("ended", onEnded); el.addEventListener("error", onError);
    el.src = item.url;
    el.defaultPlaybackRate = item.rate; el.playbackRate = item.rate; el.volume = item.volume;
    el.play().catch((error: unknown) => finish(error instanceof DOMException && error.name === "NotAllowedError" && !unlocked ? "blocked" : "failed"));
  });
}

function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  return voices.find((voice) => /en(-|_)(US|GB)/i.test(voice.lang) && /natural|neural|google|samantha|aria|jenny/i.test(voice.name)) ?? voices.find((voice) => /^en/i.test(voice.lang)) ?? null;
}

function playSpeech(item: Item): Promise<Outcome> {
  if (!("speechSynthesis" in window)) return Promise.resolve("failed");
  return new Promise((resolve) => {
    let settled = false;
    const utterance = new SpeechSynthesisUtterance(item.text);
    utterance.rate = item.rate; utterance.volume = item.volume;
    const voice = pickVoice(); if (voice) utterance.voice = voice;
    // Some browsers never fire onend; give up after a generous estimate of the speaking time.
    const timer = window.setTimeout(() => finish("ended"), 4000 + (item.text.length * 85) / item.rate);
    function finish(outcome: Outcome) { if (settled) return; settled = true; window.clearTimeout(timer); resolve(outcome); }
    cancelCurrent = () => { finish("cancel"); window.speechSynthesis.cancel(); };
    utterance.onend = () => finish("ended");
    utterance.onerror = (event) => finish(event.error === "not-allowed" && !unlocked ? "blocked" : event.error === "interrupted" || event.error === "canceled" ? "cancel" : "failed");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

async function playItem(item: Item) {
  let outcome = await playAudio(item);
  if (outcome === "failed" && current === item) outcome = await playSpeech(item);
  // Autoplay still locked: hold this line (and the queue behind it) until unlock() replays it on the first gesture.
  if (outcome === "blocked" && current === item) { waitingForGesture?.done(); waitingForGesture = item; }
  else item.done();
}

function pump() {
  if (current || waitingForGesture || !queue.length || !enabled) return;
  const item = queue.shift()!;
  current = item; emit();
  void playItem(item).finally(() => { if (current === item) { current = null; cancelCurrent = null; } emit(); pump(); });
}

export function setVoiceEnabled(value: boolean) {
  init(); enabled = value;
  if (browser()) writeStorage(ENABLED_KEY, value);
  if (!value) stopSpeaking();
  emit();
}
export function voiceEnabled() { init(); return enabled; }
export function isSpeaking() { return Boolean(current); }

// Default rate (0.5 to 2) and volume (0 to 1) for every line; persisted. speak() options override per line.
export function setVoiceOptions(options: { rate?: number; volume?: number }) {
  init();
  defaults = { rate: clamp(options.rate ?? defaults.rate, 0.5, 2), volume: clamp(options.volume ?? defaults.volume, 0, 1) };
  if (browser()) writeStorage(OPTIONS_KEY, defaults);
}
export function voiceOptions() { init(); return { ...defaults }; }

function interruptCurrent() {
  const active = current; current = null;
  cancelCurrent?.(); cancelCurrent = null;
  active?.done();
  if (browser() && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

export function stopSpeaking() {
  const dropped = queue; queue = [];
  dropped.forEach((item) => item.done());
  if (waitingForGesture) { waitingForGesture.done(); waitingForGesture = null; }
  interruptCurrent();
  emit();
}

const ttsUrl = (text: string) => `/api/forge/tts?text=${encodeURIComponent(text)}`;

// Resolves when the line has finished playing (or was dropped / interrupted).
export function speak(text: string, options: SpeakOptions = {}): Promise<void> {
  init();
  const clean = cleanText(text);
  if (!enabled || !clean || !browser()) return Promise.resolve();
  const priority = options.priority ?? "step";
  if (priority !== "correction" && !options.interrupt && (current?.text === clean || queue.some((item) => item.text === clean))) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const item: Item = { text: clean, url: options.audioUrl || ttsUrl(clean), priority, rate: clamp(options.rate ?? defaults.rate, 0.5, 2), volume: clamp(options.volume ?? defaults.volume, 0, 1), done: resolve };
    if (priority === "correction" || options.interrupt) {
      // Cut off whatever is playing; older corrections and info lines are stale, queued step lines resume afterwards.
      const keep = options.interrupt ? [] : queue.filter((queued) => queued.priority === "step");
      const dropped = queue.filter((queued) => !keep.includes(queued));
      if (waitingForGesture) { dropped.push(waitingForGesture); waitingForGesture = null; }
      queue = [item, ...keep]; dropped.forEach((queued) => queued.done());
      interruptCurrent();
    }
    else {
      if (priority === "info" && (current || queue.length)) { resolve(); return; } // info lines never wait behind others
      queue.push(item);
      while (queue.length > MAX_QUEUE) queue.shift()!.done(); // stale step lines are dropped, newest kept
    }
    pump();
  });
}

// Warms the browser HTTP cache (and the server cache) for lines that will be spoken soon.
export function prefetchVoice(text: string, audioUrl?: string) {
  init();
  const clean = cleanText(text);
  if (!browser() || !enabled || (!clean && !audioUrl)) return;
  void fetch(audioUrl || ttsUrl(clean), { priority: "low" } as RequestInit).catch(() => { /* best effort */ });
}

export function subscribeVoice(listener: () => void) { init(); listeners.add(listener); return () => { listeners.delete(listener); }; }
const serverSnapshot = { enabled: true, speaking: false };

// Tiny hook for voice toggles and "speaking" indicators.
export function useVoice() {
  const state = useSyncExternalStore(subscribeVoice, () => snapshot, () => serverSnapshot);
  return { enabled: state.enabled, speaking: state.speaking, toggle: () => setVoiceEnabled(!voiceEnabled()) };
}
