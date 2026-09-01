# Meditation Posture Tracker

Live at **https://tobifunkfunk.github.io/posture-tracker/** — open it on the
iPhone and add to Home Screen. Pages serves over HTTPS, which is what the
camera needs, so this is an easier route onto the phone than the LAN dev
server.

A PWA that watches your seated posture through a phone on a tripod and turns it
into numbers you can follow over weeks. Everything runs on the device: no video
is recorded or transmitted, only joint angles are stored, and there is no server.

## The three questions it answers

- **Are my shoulders the same height?**
- **Is there a tilt in my body?**
- **Is there a rotation in my body or head?**

These are entangled, so the app is built to separate them rather than report
three correlated numbers as if they were independent:

| KPI | What it isolates |
|---|---|
| `shoulderOnlyTilt` | Shoulder tilt with whole-body lean subtracted. A shoulder that drops *because the trunk lists* reads zero here; only genuine girdle asymmetry survives. |
| `torsoTwist` | Shoulder rotation minus pelvis rotation. A cushion sitting at an angle turns both together and cancels; only a real twist survives. |
| `headYawVsShoulders` | Head rotation relative to the torso, so "head turned" is separate from "whole body turned". |

## Why calibration is not optional

Three biases would each swamp the signal:

1. **The camera isn't level.** 3° of tripod roll reads as 3° of shoulder tilt,
   invisibly. Removed using the phone's own gravity vector.
2. **The camera is 35° off-axis.** Removed by a reference sit that measures the
   camera's azimuth.
3. **Nobody is symmetric.** So the honest output is *deviation from your own
   reference* and *drift over the session*, not absolute anatomical truth.

Calibration settles four things: camera level, whether the feed is mirrored
(via a "raise your right hand" check), the tripod's angle, and your neutral.

**Re-calibrate whenever the tripod or cushion moves.** Mark both with tape.
Sessions are only comparable within one camera profile, and the app enforces
this — trends are computed per profile and cross-profile sessions are flagged.

## Setup

```bash
npm install
```

`npm install` also fetches the MediaPipe models and wasm runtime into
`public/` (about 45 MB). They are deliberately kept out of git — run
`npm run setup` by hand if you ever need to re-fetch them.

Test on the laptop (localhost counts as a secure context, so no certificate needed):

```bash
npm run dev
```

Test on the iPhone over your LAN — this needs real HTTPS for the camera:

```bash
npm run dev:lan
```

Accept the self-signed certificate once on the phone. For anything other than
active development, the deployed Pages build above is the easier way onto the
phone.

Check the production build locally, served at the same base path Pages uses:

```bash
npm run build && npm run preview
```

```bash
npm test
```

## How it works

```
MediaPipe worldLandmarks (metres, hips at origin, camera-aligned)
  → toPhysics    flip to +Y up, +Z toward camera
  → applyMirror  undo a mirrored feed, un-swapping left/right labels
  → gravityAlign minimal rotation putting true vertical on +Y
  → yawAlign     remove the camera's azimuth
  → computeMetrics
```

`src/posture/` is free of DOM and MediaPipe types, so all the geometry is
unit-tested against synthetic bodies projected through synthetic cameras: a
known 5° tilt must read 5.0°, a 10° camera roll must cancel exactly, and a pure
whole-body lean must produce zero shoulder asymmetry.

Sampling runs at **5 Hz on a timer**, not every animation frame. Meditation is
near-static, warm inference is ~14 ms, and this is the difference between a
phone that survives a 45-minute sit and one that thermally throttles. Samples
are smoothed with a One Euro filter and decimated to 1 Hz for storage.

## Known limits

- **Repeatability, not absolute truth.** MediaPipe's shoulder landmarks are
  joint centres inferred from a silhouette; loose or asymmetric clothing shifts
  them by more than the asymmetry you are chasing. Wear something consistent.
- **Under ~1° is noise** and the UI says so rather than implying precision.
- **Hips are the weak link** when sitting cross-legged. Hip-dependent KPIs are
  gated on visibility and excluded from aggregates rather than averaged in;
  the session quality score makes the gap visible.
- **Forward lean is the weakest axis** even at 35°. If slump becomes the main
  interest, a session with the camera at 60–90° measures it far better, at the
  cost of shoulder height and rotation.
- **iOS PWA camera is occasionally flaky** in standalone mode. The app detects
  a dead stream and suggests opening in Safari instead of showing black.

## Layout

```
.github/       Pages build-and-deploy workflow
src/posture/   pure geometry — frames, metrics, filter, aggregation, recorder
src/capture/   camera, MediaPipe wrapper, device orientation
src/store/     IndexedDB
src/nudge/     chime, ambient glow, the out-of-band engine
src/ui/        screens, gauges, charts, overlay
tests/         synthetic bodies and cameras
```
