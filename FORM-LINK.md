# Form Link

Form Link replaces chained patterns with a **chart**: a song form of sections (A, B, C…), each with a key, a mode, a length and a few "feel" values. The apps keep generating from their own clocks and gates. The chart only tells them what harmonic world they are in, how it should feel, and when it is about to change.

The conductor lives in Mixing Desk, in the **Form** panel. The desk's transport carries tempo, start/stop and the beat grid as it already does; Form Link adds what happens over many bars.

## The chart

```js
{
  v: 1,
  name: 'Half-step bridge',
  order: ['A', 'A', 'B', 'A'],   // played in turn, then loops
  loop: true,
  sections: {
    A: {
      root: 2,                    // pitch class, 0 = C
      mode: 'dorian',             // Jam Link mode ids: major minor dorian phrygian lydian
                                  // mixolydian locrian majPent minPent blues harmMinor
      length: { type: 'fixed', bars: 8 },
      feel: { density: 0.45, register: 0.5, brightness: 0.5 },   // all 0–1
      enter: 'hard'               // how the music arrives in this section
    },
    B: {
      root: 3, mode: 'dorian',
      length: { type: 'vamp', min: 4, max: 16,
                rule: { kind: 'gate', a: 3, b: 5, op: 'AND' } },
      feel: { density: 0.7, register: 0.65, brightness: 0.7 },
      enter: 'pivot'
    }
  }
}
```

### Lengths

- **fixed**: exactly `bars` bars.
- **vamp**: an open section. It plays at least `min` bars and at most `max`. In between, it moves on when its rule fires at the end of a bar:
  - `{ kind: 'gate', a, b, op }` counts bars played in the section, *n*, and treats "*n* is a multiple of *a*" and "*n* is a multiple of *b*" as two clocks combined with `AND`, `OR` or `XOR`. Clock 3 AND clock 5 leaves after bar 15; OR leaves at the first multiple of either.
  - `{ kind: 'chance', pct }` leaves with that probability each bar.
- A **cue** from the conductor (a button, or a MIDI note later) ends the current section after the bar that follows, whatever its length says. The extra bar gives every app time to fill.

The conductor decides at the **start** of each bar whether that bar is the section's last, so apps always know one bar ahead.

### Entering a section

- **hard**: the new key and mode apply on the downbeat.
- **pivot**: for the first bar, apps use only the notes the old and new scales share (when there are at least three), then the full new scale. This is the smooth way between related modes, such as C Lydian to A minor.
- **anticipate**: in the last beat of the old section, apps lean into the new one. Melody aims at the new root, and pads move to the new voicing early.

A half-step lift such as D Dorian to Eb Dorian is written in the chart as the next section's key. It doesn't need a special style.

### Feel

Three numbers that every app interprets its own way:

| Feel | Melody Machine | Choir | Logic Rhythm |
| --- | --- | --- | --- |
| `density` | Gate logic bias: low leans AND, high leans OR | How often it re-voices | Which clocks are active, hat rate |
| `register` | Center of the S&H range | Voicing octave | Tuning of tuned drums |
| `brightness` | Filter, color-tone weighting | Vowel range: low = oo/o, high = ah/eh | Accent level, open hats |

## Messages

The desk sends every message two ways:

- To each hosted app, as a guest-protocol message (`discobotGuest: 1`) of type **`form`** for `bar` and **`form-chart`** for `chart`, with the fields below. Apps that don't know these types ignore them, as the guest protocol already does for unknown types.
- On the BroadcastChannel **`aaronvandorn-form-v1`**, for apps open in other tabs. It is separate from Jam Link's channel, so it never disturbs it.

Every message has `v: 1`, `from` (sender id) and `t`.

### `chart`

Sent when the conductor links, when the chart is edited, and in reply to `chart-request`.

```js
{ v: 1, t: 'chart', from, chart: { ...the chart above } }
```

### `bar`

Sent for every bar, one beat before its downbeat, so apps can schedule against it even though hosted apps play about 120 ms early.

```js
{
  v: 1, t: 'bar', from,
  wall: 1767046800123.4,     // wall-clock ms of the downbeat (performance.timeOrigin + performance.now())
  sharedBeat: 64,            // the desk's beat number of the downbeat (4 beats to the bar)
  bar: 16,                   // bars since play
  section: 'B', index: 2,    // section letter, position in order
  barInSection: 0,           // 0-based
  barsLeft: 8,               // bars remaining including this one; null in an open vamp until its last bar
  last: false,               // this bar is the section's last
  root: 3, mode: 'dorian',
  scale: [3, 5, 6, 8, 10, 0, 1],   // pitch classes to quantize to in this bar (pivot bars send the common tones)
  feel: { density: 0.7, register: 0.65, brightness: 0.7 },
  enter: 'pivot',            // how this section was entered
  changed: true,             // first bar of a new section
  next: { section: 'A', root: 2, mode: 'dorian', enter: 'hard' }   // the following section
}
```

### `chart-request`

An app that opens late sends `{ v: 1, t: 'chart-request', from }`. The conductor answers with `chart`, and the next `bar` message brings it up to date.

## How an app follows it

1. In a host, handle guest messages of type `form` and `form-chart` in Jam Link's host handler. In a tab, listen on `aaronvandorn-form-v1`.
2. On `bar`, store the message and apply it at its downbeat. `sharedBeat` is on the same beat count as the host's `transport` messages, so it can be compared with the beats the app already schedules (or convert `wall` with `getOutputTimestamp()`, as Jam Link does).
3. Quantize with `scale`, not with `root` and `mode`, so pivot bars come out right.
4. Use `last`, `barsLeft` and `next` for fills, pickups and anticipation.
5. Map `feel` onto the app's own controls as an offset or bias, not an overwrite, so the hand-set patch still matters.

Inside the desk, Jam Link's own key sharing is off (the desk is the host), so the apps need this small addition to Jam Link's host handler before they change key with the form. Until then, the desk's guide voices play the chart. Choir has no Blues or Harmonic Minor; for those it should keep its mode and take only the root, as Jam Link already does for shared keys.

## Suggested Jam Link changes

- In the host handler, accept `form` and `form-chart` and pass them to the app through a new `o.form(msg)` option, and apply `root`/`mode` through the existing `o.key.set` at the downbeat, so apps that only supply `key` follow the form with no other changes.
- The same for the BroadcastChannel, so apps in tabs follow a desk running in another tab.

## Later

- MIDI: cue on a note, send the section as a program change, and section feel as CCs for outboard gear.
- Per-section app parts: mute or bring in an app by section, like an arrangement, while the notes stay generative.
- A groove-box build that combines Melody Machine and Logic Rhythm keeps this chart as its arranger.
- Logic-driven form across apps: let a gate in one app (for example Logic Rhythm's clock 3 AND clock 5 on a downbeat) be the vamp rule.
