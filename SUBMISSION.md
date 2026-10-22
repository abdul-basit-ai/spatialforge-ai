# SpatialForge

**Live demo:** https://eggs-mission-knee-spokesman.trycloudflare.com

SpatialForge is an AI assembly co-pilot for mechanical and mechatronic technicians and the training managers responsible for getting them productive. Assembly knowledge is often trapped in CAD, static manuals, and experienced technicians. SpatialForge turns STEP/STL/glTF files, PDFs, images, or a plain-language prompt into a reviewed interactive lesson with typed steps such as place, fasten with torque, connect, route, adjust, inspect, and choose a tool.

Technicians can train in an interactive 3D scene, practise with virtual parts on a real table, or use AR assist over real hardware. OpenAI vision can check visible work, ElevenLabs speaks every instruction and correction, and name-and-PIN sign-in connects each run to personal coaching memory. Managers can inspect where people struggle, review an AI Critic proposal, approve a new guidance version, and compare its measured impact.

## How the agents depend on data

1. Training events stream into **Aiven for ClickHouse**. The Critic identifies high-error steps, cites the evidence, and proposes a targeted instruction change. A manager must approve it before a new version becomes active, and later runs show whether the error rate changed.
2. **Aiven for PostgreSQL** stores scenarios and versions, people, sessions, approvals, and long-term technician memory.
3. **Aiven for Valkey** holds short-term session memory, the Critic job queue, guidance caches, and other low-latency state.
4. **OpenAI** compiles CAD, PDFs, images, and prompts into structured lessons, provides personalised coaching, generates Critic proposals, and checks camera images against visible step requirements.
5. **ElevenLabs** generates the hands-free voice line for every step and correction.

## Aiven services used

- Aiven for PostgreSQL
- Aiven for ClickHouse
- Aiven for Valkey
- Aiven Runtime is the intended application host; the hackathon demo currently runs on this laptop through a Cloudflare tunnel because the Runtime deployment is not complete.

## How to try it

1. Open https://eggs-mission-knee-spokesman.trycloudflare.com/train/linear-actuator and complete the guided 3D assembly, or choose another built-in scenario from `/train`.
2. Open `/train/aerospace-centrifugal-compressor-assembly-training` to see the 15-step, eight-part lesson compiled from SolidWorks screenshots, with ElevenLabs audio on every step. `/train/small-bench-vise-assembly` shows a lesson generated from a prompt and web research alone.
3. Open `/admin`, enter the organiser-provided admin token, and review the pending valve Critic proposal backed by a 60% spool-step error rate. Leave it pending until the live demo, then approve it to show the governed improvement loop.

The creation workflow lives at `/studio`; name-and-PIN sign-in is at `/signin`.

## Honest limitations

- Native SolidWorks files require a STEP export before upload.
- The aerospace compressor geometry is AI-approximated from screenshots rather than exact production CAD.
- iPhone AR currently displays the lesson but is not anchored to a detected real-world surface.
- Aiven Runtime deployment is not complete, so the live demo uses a temporary Cloudflare tunnel from this laptop.
- Admin access currently uses one shared token rather than named administrator accounts and role-based access.
- Camera checks can assess visible placement and orientation, but cannot prove hidden state, torque, or safety-critical quality without appropriate sensors and qualified procedures.

## Route to the first users

The initial buyers are OEM training and service teams, industrial distributors and system integrators, and technical colleges or apprenticeship providers. The first ten pilots target four OEMs, three distributors/integrators, and three colleges. Each six-week pilot starts with one frequent, observable assembly, an agreed baseline, a supervised technician cohort, weekly review, and a final conversion decision. Indicative pricing is from $1,500 for a pilot, $19 per technician per month for Team, and custom education agreements. Pilot success is measured with completion, time to independence, corrections per run, first-pass completion, supervisor interventions, knowledge score, confidence, repeat use, and approval-to-release time; no improvement is claimed before measurement.

## Repository

https://github.com/abdul-basit-ai/spatialforge-ai
