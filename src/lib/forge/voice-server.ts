import type { ForgeScenario } from "./types";

// Server-side ElevenLabs synthesis with caching (forge_audio in PostgreSQL). Contract stub: the voice agent implements it.
// synthesize() returns mp3 bytes or null when ElevenLabs is unavailable (callers then fall back to browser speech).
export async function synthesize(text: string): Promise<{ key: string; bytes: Buffer; mime: string } | null> {
  void text;
  return null;
}

// Pre-generates audio for every step's voiceLine and returns the scenario with step.audio.url filled in where it succeeded.
export async function generateScenarioAudio(scenario: ForgeScenario): Promise<ForgeScenario> {
  return scenario;
}
