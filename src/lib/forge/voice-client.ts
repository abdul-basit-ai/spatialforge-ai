"use client";

// Browser voice guidance. Plays cached ElevenLabs audio from the server (/api/forge/tts), falls back to speechSynthesis.
// Contract: speak() interrupts whatever is playing; stopSpeaking() silences; setVoiceEnabled() persists the toggle.
let current: HTMLAudioElement | null = null;
let enabled = true;

export function setVoiceEnabled(value: boolean) { enabled = value; if (!value) stopSpeaking(); }
export function voiceEnabled() { return enabled; }

export function stopSpeaking() {
  current?.pause(); current = null;
  if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

export async function speak(text: string, options: { audioUrl?: string } = {}) {
  if (!enabled || !text.trim() || typeof window === "undefined") return;
  stopSpeaking();
  const url = options.audioUrl ?? `/api/forge/tts?text=${encodeURIComponent(text.slice(0, 600))}`;
  try {
    const audio = new Audio(url); current = audio;
    await audio.play();
  } catch {
    if ("speechSynthesis" in window) window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}
