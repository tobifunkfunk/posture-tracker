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
| `headRoll` | Head tilt, fused from the eye line and the ear line by visibility. Ears give a longer baseline and so less angular noise; eyes are rarely hidden. Whichever is actually visible carries the estimate. |

## The trunk axis comes from the outline, not the hips

Hips are the wrong landmark for seated meditation. On a bench or kneeling
stool they are occluded or oddly posed, and MediaPipe's estimate degrades
accordingly — yet lateral lean, and therefore shoulder asymmetry, used to hang
entirely off the hip midpoint.

The silhouette does the job better. Taking the horizontal centroid of the body
at each height across the chest fits a centre line through thousands of pixels
instead of two guessed points, and it lives in the image plane, which is the
axis the camera observes best. In testing it resolves a 1.5° lean, well below
anything two hip landmarks could distinguish.

What the outline genuinely cannot show is depth. Forward lean, pelvis rotation
and twist all need the hips, so on a bench they are reported as unavailable
rather than guessed. The app detects this from your sits and the report hides
that section, with a note, instead of showing a column of dashes.

## Where to put the camera

The app works out the tripod angle by itself, so any placement works. But
landmark noise lives in the camera frame and depth is much noisier than the image
plane, so the angle decides which KPIs get the good axis. Measured by
simulation (`tests/noise-sensitivity.test.ts`, RMS error in degrees):

| camera | shoulder tilt | shoulder asymmetry | lateral lean | forward lean | twist |
|---|---|---|---|---|---|
| **front (0°)** | 2.10 | **2.39** | **1.06** | 3.10 | 14.6 |
| oblique (35°) | 2.14 | 2.94 | 2.01 | 2.62 | 12.7 |
| side (90°) | 2.17 | 3.76 | 3.12 | **1.05** | **5.4** |

**Straight in front is the best placement for shoulder height and body tilt** —
lateral lean is three times more accurate frontal than side-on. Move the
tripod off-axis only if forward slump is what you care about most.

Shoulder tilt itself barely cares about the angle: it is a vertical
difference, and vertical is always well observed.

**Twist is noisy at every angle.** It rides the hip line, whose short baseline
amplifies depth error. Per frame it is unusable, so the live dial shows a
30-second average and the report leans on session means, where the error falls
by the square root of the sample count to well under a degree.

## Helping the detection

The app shows a live **signal quality** panel during calibration: how much the
shoulder reading wobbles while you hold still, in degrees. That is the number
to optimise, and it makes setup an experiment rather than a guess — change one
thing, watch it move.

What reliably helps:

- **Even, frontal light.** Backlight is the single worst thing; a bright window
  behind you reduces you to a silhouette.
- **A plain background that contrasts with your clothing.** This mainly helps
  the outline, which is derived from a segmentation mask.
- **Close-fitting, plain clothing.** Loose fabric moves the apparent shoulder
  point by more than the asymmetry being measured.
- **Wearing the same thing each time.** Trends are the product here, so
  removing a variable beats optimising it.

What does not help: patterned or striped clothing. It does nothing for
landmark accuracy and actively risks confusing the segmentation the outline is
built from — and the outline is now what measures your lean, so that matters
more than it used to.

A **fixed background** is worth setting up, but not for the reason it seems.
The pose model is a neural network trained on natural images; it does not
triangulate against background features, so reference marks behind you are
simply ignored, and a grid or ruled sheet buys nothing for detection. What a
constant background is genuinely good for is telling you the *setup* has not
drifted: same room, same wall, same marks, so a changed frame is visible at a
glance. Since every trend in this app assumes sessions share a camera pose,
that is the assumption most worth protecting. Plain and unchanging beats
patterned and unchanging.

## There is no calibration step

Put the phone on a tripod facing you and sit. The app works out its own setup
as it goes.

This is possible because of what each KPI is referenced to. Shoulder tilt,
shoulder height, lateral lean, asymmetry and every head-tilt measure are
referenced to **gravity**, which the phone reports directly — they are
absolute, correct from the very first sit, and comparable across sessions with
no baseline whatsoever. `tests/azimuth-invariance.test.ts` pins exactly which
metrics these are.

Torso rotation is the one exception, and it is offset *exactly* by any error
in the assumed camera angle. Being linear, it can be corrected after the fact:
each sit records with whatever angle is currently believed, then the stored
values are shifted onto a better estimate once the sit supplies one. That is
why recording starts immediately rather than after a settling period.

The camera angle itself is **pooled across sessions**. A single camera cannot
distinguish a tripod standing 10° off-axis from a person sitting rotated 10° —
that ambiguity is real and no ritual removes it. But where the camera stands
is fixed while how you sit varies, so the pooled estimate converges on the
camera and each session's departure from it is you. What survives is *change
in rotation over time*, which is the useful part; absolute rotation is not
claimed. A sit whose geometry differs by more than 25° is treated as a moved
camera and flagged, rather than quietly averaged into the profile.

Gravity is re-read at the start of every sit, so a tripod nudged between
sessions corrects itself with nothing to remember.

The old calibration screen survives as an optional **camera check** — framing
plus the live signal-quality meter — but nothing gates on it.

## Why the reference matters anyway

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
