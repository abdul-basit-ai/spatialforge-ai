# SpatialForge AI — Implementation Plan

## Current implementation status

The first guided assembly phase is implemented: the Precision Tray remains an unrestricted practice scenario, and the Small Valve Assembly adds accessible parts with prerequisite, target, orientation, voice, event, and passport checks. Physical-part inspection, room anchoring, PDF import, and automatic DAG revisions remain future phases.

## Summary

Build the four-shape assembly as the first usable release on desktop and iPhone 14. Operators choose a one-digit identity, complete virtual placements with hand gestures, and receive live voice guidance. Mistakes persist across sessions. A separate admin reviews proposed instruction changes and missing-part alerts. Add guided PDF import in the next milestone.

## Implementation

- **Spatial workbench:** Use Next.js, TypeScript, Three.js, and Vercel. Desktop shows a 3D workbench; mobile uses rear-camera AR with the 8th Wall SLAM binary to anchor the tray without extra equipment. Its open-source framework lacks world tracking, so include the binary's required attribution and license notice.
- **Four-shape workflow:** Place Cylinder Core, Hexagonal Valve Block, Cube Module, and Toroid Seal Ring into slots A1–A4. Use visible orientation cues on the hexagonal block and cube. Map the tracked pinch position through the camera onto the tray plane for grab, rotation, wrong-slot interception, and drop; use thumbs-up or open-palm hold for confirmation. Provide touch controls when tracking is lost.
- **Verification and voice:** Make virtual slot and orientation checks deterministic. Sample the shared camera feed for MediaPipe; send 256 × 256 crops to OpenRouter only for optional inspection, never as a frame-by-frame dependency. Pin requests to `z-ai/glm-5.3-flash` with `allow_fallbacks: false` and price sorting. Stream ElevenLabs Flash v2.5 guidance, with captions and voice-command fallback. Treat 60 FPS rendering and sub-500 ms responses as measured targets, not certification guarantees.
- **Memory and review:** Keep current hesitation and mistakes in Zustand; save events, operator digit, sessions, and DAG versions in Supabase. After a session, the critic proposes shields, simpler substeps, or revised prompts. An authenticated admin previews and approves each version before it becomes active. Approved missing-SKU events go to a demo n8n webhook with no purchase action. Show error and completion trends by DAG version in Lightdash.
- **Completion record:** Hash a canonical record of the selected scenario's verified placements, target IDs, rotations, DAG version, timestamp, and entered digit with SHA-256; store it as an append-only demo passport. Label the digit as self-declared identity. Physical-part inspection remains outside this release.
- **Next milestone:** Use `unpdf` and the pinned model to propose steps, parts, and parametric shapes from an uploaded PDF. An admin corrects the proposed scene and approves publication; PDFs that lack enough assembly detail remain drafts.

## Acceptance scenarios

- On desktop and iPhone 14, an operator can finish all four placements; wrong slots and keyed orientation errors block completion and trigger immediate visual and voice guidance.
- A returning digit sees coaching informed by its saved mistakes. An approved DAG revision changes the next session; an unapproved proposal does not.
- Only the admin can publish a DAG revision or send the approved demo webhook. Completion produces a reproducible hash tied to the recorded evidence.
- The iPhone session can finish with touch controls if hand tracking fails. Camera, microphone, network, or AI failure gives a clear recovery path without falsely completing a step.
- In the next milestone, a reviewed PDF draft can become a playable scene; an incomplete extraction cannot publish automatically.

## Assumptions

- This is a small-team demo with at most ten self-declared operator digits and one authenticated admin.
- “VR workbench” means an interactive desktop 3D digital twin in the first release; headset immersion is a later extension.
- iPhone AR uses one hand to hold the phone and the other within rear-camera view for gestures.

## References

- [8th Wall engine distributions](https://8thwall.org/docs/open-source)
- [8th Wall camera pipeline](https://8thwall.org/docs/api/engine/xr8/addcamerapipelinemodule)
- [ElevenLabs latency guidance](https://elevenlabs.io/docs/api-reference/reducing-latency)
