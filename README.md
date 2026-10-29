# Mixing Desk

A performance mixing console for the music apps, running entirely in the browser. Each app runs inside the desk as a channel: the desk drives every app's tempo and start/stop from one transport, takes each app's sound into its own channel strip, and records the mixdown.

Live at **https://aaronvandorn.github.io/Mixing-Desk/** (once GitHub Pages is switched on for this repo).

- **Channels:** add Logic Rhythm, Boolean Melody Machine, Choir, Pocket Mouse, Pocket Grains or Tape Loop Deck from the list, or paste the address of any other app. Audio files (looped on the bar grid) and live audio inputs can be channels too.
- **Channel strip:** gain, low cut, 3-band EQ with sweepable mid, and an effects bus with a DJ-style filter (low-pass one way, high-pass the other), drive, a tempo-synced echo with feedback, and a reverb send. Then pan, a volume fader, mute and solo.
- **Reverb return:** one shared reverb with size, tone and its own fader, fed by every strip's Verb send.
- **Master:** bus limiter with a gain-reduction readout, master fader, and a safety ceiling at 0 dBFS.
- **Meters:** stereo level on every strip, the reverb return and the master: a level bar, a peak-hold line, and a clip light (click it to reset). The master also shows its highest peak in dBFS.
- **Transport:** Play/Stop, bar.beat counter, tempo (type, drag, or Tap), and a metronome click that goes to your speakers only and is never recorded. Space plays and stops; R records.
- **Channel transport:** each strip has its own Play/Stop and Restart. While the desk is playing, a channel you start comes in on the next bar line, and Restart takes it back to the top of its pattern on the next bar line. While the desk is stopped, a strip's Play button arms or disarms it for the next Play.
- **Form:** a song-form conductor in place of chained patterns. Build a chart of sections (A, B, C, D), each with a root, a mode, a length and a feel (density, register, brightness), and put them in order, like a lead sheet. A section is either a set number of bars or an open vamp that moves on when two bar-count clocks meet through an AND, OR or XOR gate, or by chance. Each section is entered Hard (new key on the downbeat), by Pivot (common tones only for the first bar) or by Anticipate (leaning into the new key on the last beat). **Cue next section** (MIDI CC 29 on channel 16 by default) ends the current section after the next bar. Each bar the desk tells every app where it is in the form; see [FORM-LINK.md](FORM-LINK.md). Optional guide voices (gate melody, quartal choir, logic drums) play the chart into the master bus. The chart saves with the project.
- **Mixdown recorder:** records the master bus exactly as you hear it. Start on the next bar line or straight away, for a set number of bars or until you stop (a bar-synced take stopped by hand ends on the next bar line, so it loops). Optionally records stems (each strip after its fader) at the same time. Takes can be auditioned, renamed and downloaded as WAV (16-bit, 24-bit or 32-bit float), MP3, or a .zip of stems plus the mix.
- **Shared export:** the ecosystem's Export bar (`jam-clips.js`) saves the last N bars of the mix as WAV, with the console's fader, pan, mute and other moves as MIDI controller tracks. Tape Loop Deck can grab bar-exact clips of the whole mix from its **Capture from** bar.
- **MIDI:** every knob, fader and button is mappable. Each strip gets its own MIDI channel with a default CC layout, the master, transport and reverb return sit on channel 16, and MIDI learn remaps anything. Needs a browser with Web MIDI (Chrome, Edge, Opera).
- **Projects:** save a project file with the apps, each app's own settings, every mixer setting, the tempo, the MIDI map and any audio files. The desk also remembers the current session in the browser (without audio files).
- **Views:** Apps (the hosted app full size), Console, or Both. Dark and light themes.

Nothing is uploaded; all audio stays in your browser.

## How apps connect

The desk speaks the same guest protocol as [Discobot](https://iw978599.github.io/discobot/)'s rack ([GUEST_PROTOCOL.md](https://github.com/iw978599/discobot/blob/main/docs/GUEST_PROTOCOL.md), version 1). Logic Rhythm, Boolean Melody Machine, Choir, Pocket Mouse, Pocket Grains and Tape Loop Deck already implement it, so they plug in with no changes:

1. The app loads in a frame and says it is `ready`. The desk answers `hello` with how early to play (`latencyMs`, 120 ms to start with).
2. The desk sends `transport` messages: start on a given beat at a given wall-clock time, tempo changes, stop. Each app schedules its own notes on those beats.
3. The app goes silent on its own speakers and sends its output to the desk as stereo PCM blocks, each stamped with the wall time its first sample would have been heard. It plays `latencyMs` early; the desk places each block `latencyMs` after its stamp, so the two cancel and every app lands on the beat. If an app's audio keeps arriving late, the desk raises that app's latency and tells it.
4. The desk asks for each app's settings every few seconds (`getState`) and hands them back when a session or project is opened (`setState`), so each app comes back exactly as it was.

The handshake says `host: 'discobot'`, because that is what the apps look for, so their Jam Link dock reads "Discobot" while they are in the desk. Jam Link's own tab linking is switched off inside a host, as it is in Discobot: the desk's transport is in charge.

Apps that don't speak the protocol still load and can be played, but their sound can't reach the console. For those, use a **Live input** channel and route the sound in from an audio interface or a loopback device.

## Files

- `index.html` — the page and its styles.
- `desk.js` — console, transport, app hosting, recorder, MIDI and projects.
- `form.js` — the Form conductor: chart editor, the form engine on the desk's timeline, Form Link messages and the guide voices.
- `FORM-LINK.md` — the Form Link message format, for apps that want to follow the chart.
- `mixer-core.js` — the audio engine with no UI: channel strip, reverb return, master bus, meters, the guest audio player, a sample-exact recorder tap, and WAV/MP3 writers. Other apps (Tape Loop Deck's console, for one) can build on it.
- `jam-clips.js` — the shared capture/export module, an identical copy of the one in the other apps.

## Running a local copy

Serve the folder, for example `python -m http.server 8000`, and open `http://localhost:8000/`. To host local copies of the apps too, serve a folder that contains them all and add `http://localhost:8000/Logic-Rhythm/` (and so on) with **Add URL**.
