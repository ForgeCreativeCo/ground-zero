import { config } from '../config';
import { events } from '../core/events';

/**
 * Synthesized placeholder audio (DESIGN.md §11): wind that rises with speed, the sonic-boom
 * crack, landing thuds and wall slams. Web Audio only; real samples can be mapped in later.
 * The context starts on the first key or click (browsers block audio before a gesture).
 */
export class Synth {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private fxBus!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private noise!: AudioBuffer;
  private bursts = 0;
  private muffle!: BiquadFilterNode;
  private heatGain!: GainNode;
  private heatOsc: OscillatorNode[] = [];
  private sizzleGain!: GainNode;
  private sizzleFilter!: BiquadFilterNode;
  private breathGain!: GainNode;
  private chargeGain!: GainNode;
  private chargeOsc!: OscillatorNode;

  constructor() {
    const start = () => this.start();
    window.addEventListener('keydown', start, { once: true });
    window.addEventListener('mousedown', start, { once: true });
    events.on('player:sonicBoom', () => this.boom());
    events.on('player:landing', (e) => {
      if (e.hard) this.thud(e.impactSpeed / 60, e.dive);
    });
    events.on('player:impact', (e) => this.slam(e.speed / 80));
    events.on('player:punch', (e) => this.punch(e.strength / 60, e.target !== 'none', e.uppercut));
    events.on('player:slam', (e) => this.groundSlam(e.radius / 20));
    events.on('player:throw', () => this.whoosh());
    events.on('glass:shatter', (e) => this.glass(e.x, e.y, e.z, e.count));
    events.on('piece:destroyed', (e) => this.breakSound(e.x, e.y, e.z, e.mass, e.material === 3));
    events.on('piece:damaged', (e) => this.crack(e.x, e.y, e.z, e.material === 3));
    events.on('building:stress', (e) => this.creak(e.x, e.y, e.z, e.duration));
    events.on('building:collapse', (e) => this.collapse(e.x, 20, e.z));
    events.on('cluster:crush', (e) => this.crush(e.x, e.y, e.z, e.mass));
    events.on('heat:burnThrough', (e) => this.crack(e.x, e.y, e.z, false));
    events.on('power:overheat', () => this.overheat());
    events.on('player:tunnelEnter', () => this.tunnelEnter());
    events.on('player:tunnelExit', () => this.tunnelExit());
    events.on('player:tunnelCrash', () => this.tunnelCrash());
    events.on('power:energyThrow', (e) => this.energyThrow(e.charge));
    events.on('power:energyBlast', (e) => this.energyBlast(e.x, e.y, e.z, e.charge));
  }

  get running() {
    return this.ctx?.state === 'running';
  }

  private start() {
    if (this.ctx || !config.audio.enabled) return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    // Inside a building at sonic speed everything is muffled (DESIGN.md §7.7).
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 22000;
    this.master.connect(this.muffle).connect(ctx.destination);
    this.fxBus = ctx.createGain();
    this.fxBus.connect(this.master);

    // Two seconds of white noise, reused by every sound.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let seed = 0x1234;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = seed / 2147483648 - 1;
    }

    // Wind: band-passed noise whose pitch and level rise with speed, plus a low rumble.
    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noise;
    windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windFilter).connect(this.windGain).connect(this.master);
    const rumbleSrc = ctx.createBufferSource();
    rumbleSrc.buffer = this.noise;
    rumbleSrc.loop = true;
    rumbleSrc.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 140;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    rumbleSrc.connect(lp).connect(this.rumbleGain).connect(this.master);
    windSrc.start();
    rumbleSrc.start();

    // Heat vision: a hum (two detuned saws, low-passed) and a sizzle where the beam lands.
    this.heatGain = ctx.createGain();
    this.heatGain.gain.value = 0;
    const hl = ctx.createBiquadFilter();
    hl.type = 'lowpass';
    hl.frequency.value = 900;
    hl.connect(this.heatGain).connect(this.fxBus);
    for (const f of [96, 193.5]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(hl);
      o.start();
      this.heatOsc.push(o);
    }
    const sizzleSrc = ctx.createBufferSource();
    sizzleSrc.buffer = this.noise;
    sizzleSrc.loop = true;
    this.sizzleFilter = ctx.createBiquadFilter();
    this.sizzleFilter.type = 'bandpass';
    this.sizzleFilter.frequency.value = 3200;
    this.sizzleFilter.Q.value = 1.2;
    this.sizzleGain = ctx.createGain();
    this.sizzleGain.gain.value = 0;
    sizzleSrc.connect(this.sizzleFilter).connect(this.sizzleGain).connect(this.fxBus);
    sizzleSrc.start(0, 0.7);
    // Freeze breath: a hiss of high noise (crackles are layered on in setPowers).
    const breathSrc = ctx.createBufferSource();
    breathSrc.buffer = this.noise;
    breathSrc.loop = true;
    const bh = ctx.createBiquadFilter();
    bh.type = 'highpass';
    bh.frequency.value = 1800;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    breathSrc.connect(bh).connect(this.breathGain).connect(this.fxBus);
    breathSrc.start(0, 1.3);
    // Energy ball: a rising electric whine while charging.
    this.chargeOsc = ctx.createOscillator();
    this.chargeOsc.type = 'square';
    this.chargeOsc.frequency.value = 110;
    const cl = ctx.createBiquadFilter();
    cl.type = 'lowpass';
    cl.frequency.value = 1500;
    this.chargeGain = ctx.createGain();
    this.chargeGain.gain.value = 0;
    this.chargeOsc.connect(cl).connect(this.chargeGain).connect(this.fxBus);
    this.chargeOsc.start();
  }

  /** Per frame: the energy-ball charge whine (pitch rises with charge). */
  setCharge(charging: boolean, charge: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.chargeGain.gain.setTargetAtTime(charging ? 0.05 + 0.08 * charge : 0, t, 0.05);
    this.chargeOsc.frequency.setTargetAtTime(110 + 520 * charge * charge, t, 0.05);
  }

  private energyThrow(charge: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.35 + 0.3 * charge, 'bandpass', 900 + 900 * charge, 0.5);
    this.tone(t, 0.3, 300 + 400 * charge, 90, 0.35);
  }

  /** The burst: a hard crack, a deep boom and debris settling (heard after it is seen). */
  private energyBlast(x: number, y: number, z: number, charge: number) {
    if (!this.ctx) return;
    const [t, g] = this.at(x, y, z);
    const k = (0.4 + 0.6 * charge) * Math.max(0.35, g);
    this.noiseBurst(t, 0.12, 'highpass', 700, 0.9 * k);
    this.noiseBurst(t, 1.2 + 1.5 * charge, 'lowpass', 600, 1.0 * k);
    this.tone(t, 1 + charge, 70, 24, 0.9 * k);
    this.noiseBurst(t + 0.3, 2.5 + 2 * charge, 'lowpass', 200, 0.5 * k);
  }

  /**
   * Per frame: heat-vision hum and sizzle (pitch by the material under the beam) and the freeze
   * breath hiss and crackle (DESIGN.md §11).
   */
  setPowers(heat: boolean, material: number, target: string, breath: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // Material ids: 3 glass, 4 steel; -1 = not a building (ground, debris) or nothing.
    const pitch =
      material === 3
        ? 1.5
        : material === 4
          ? 1.25
          : material >= 0
            ? 1
            : target === 'world'
              ? 0.85
              : 0.7;
    this.heatGain.gain.setTargetAtTime(heat ? 0.18 : 0, t, heat ? 0.03 : 0.08);
    this.heatOsc[0]!.frequency.setTargetAtTime(96 * pitch, t, 0.05);
    this.heatOsc[1]!.frequency.setTargetAtTime(193.5 * pitch, t, 0.05);
    const sizzle = heat && target !== 'none';
    this.sizzleGain.gain.setTargetAtTime(sizzle ? 0.32 : 0, t, sizzle ? 0.04 : 0.1);
    this.sizzleFilter.frequency.setTargetAtTime(2400 * pitch + 800, t, 0.05);
    this.breathGain.gain.setTargetAtTime(breath ? 0.22 : 0, t, breath ? 0.05 : 0.12);
    if (breath && this.gate('crackle', 0.045) && (this.bursts & 3) !== 0) {
      const f = 4000 + ((this.bursts * 1301) % 4000);
      this.noiseBurst(t, 0.03, 'highpass', f, 0.18);
    }
  }

  private overheat() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.8, 'highpass', 2500, 0.35);
    this.tone(t, 0.4, 600, 200, 0.12);
  }

  /** Punching into a building at sonic speed: a deep crunch, then muffled inside. */
  private tunnelEnter() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tone(t, 0.5, 90, 28, 0.9);
    this.noiseBurst(t, 0.45, 'lowpass', 1400, 0.9);
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setTargetAtTime(420, t + 0.04, 0.03);
  }

  /** Bursting out of the far side: the sound comes back all at once. */
  private tunnelExit() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setValueAtTime(22000, t);
    this.noiseBurst(t, 0.12, 'highpass', 800, 0.9);
    this.noiseBurst(t, 1.6, 'lowpass', 900, 0.9);
    this.tone(t, 0.9, 75, 30, 0.8);
    // Glass and debris raining out behind him.
    this.noiseBurst(t + 0.15, 1.2, 'highpass', 3800, 0.35);
  }

  private tunnelCrash() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.muffle.frequency.cancelScheduledValues(t);
    this.muffle.frequency.setTargetAtTime(22000, t + 0.3, 0.4);
    this.tone(t, 0.9, 70, 25, 1);
    this.noiseBurst(t, 1.2, 'lowpass', 700, 1);
    this.noiseBurst(t, 2.5, 'lowpass', 220, 0.5);
  }

  /** Per frame: speed drives the wind. */
  /** Listener (camera) position for distance falloff and sound travel delay. */
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private last = new Map<string, number>();

  setListener(x: number, y: number, z: number) {
    this.lx = x;
    this.ly = y;
    this.lz = z;
  }

  /** Rate limit per sound type; returns false if it played too recently. */
  private gate(key: string, minGap: number) {
    const now = this.ctx?.currentTime ?? 0;
    const prev = this.last.get(key) ?? -1;
    if (now - prev < minGap) return false;
    this.last.set(key, now);
    return true;
  }

  /** Start time (travel delay at 343 m/s, capped) and distance gain for a world position. */
  private at(x: number, y: number, z: number): [number, number] {
    const d = Math.hypot(x - this.lx, y - this.ly, z - this.lz);
    const delay = Math.min(3, d / 343);
    return [this.ctx!.currentTime + delay, 1 / (1 + d / 60)];
  }

  update(speed: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const a = config.audio;
    this.master.gain.setTargetAtTime(a.enabled ? a.masterVolume : 0, ctx.currentTime, 0.05);
    this.fxBus.gain.setTargetAtTime(a.effectsVolume, ctx.currentTime, 0.05);
    const k = Math.min(
      1,
      Math.max(0, (speed - a.windStartSpeed) / (a.windFullSpeed - a.windStartSpeed)),
    );
    this.windGain.gain.setTargetAtTime(k * k * a.windVolume * 0.9, ctx.currentTime, 0.12);
    this.windFilter.frequency.setTargetAtTime(250 + 2600 * k, ctx.currentTime, 0.15);
    this.rumbleGain.gain.setTargetAtTime(k * a.windVolume * 1.4, ctx.currentTime, 0.2);
  }

  private noiseBurst(t: number, dur: number, type: BiquadFilterType, freq: number, gain: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f).connect(g).connect(this.fxBus);
    this.bursts = (this.bursts + 1) % 97;
    src.start(t, (this.bursts * 0.37) % 1.5, dur + 0.05);
  }

  private tone(t: number, dur: number, from: number, to: number, gain: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.fxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  punch(intensity: number, hit: boolean, uppercut: boolean) {
    if (!this.ctx || !this.gate('punch', 0.05)) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1.5, Math.max(0.3, intensity));
    if (hit) {
      this.tone(t, 0.22, uppercut ? 180 : 150, 50, 0.7 * Math.min(1, k));
      this.noiseBurst(t, 0.18, 'lowpass', 1600, 0.55);
    } else {
      this.noiseBurst(t, 0.14, 'bandpass', 900, 0.25); // whiff
    }
  }

  whoosh() {
    if (!this.ctx) return;
    this.noiseBurst(this.ctx.currentTime, 0.35, 'bandpass', 700, 0.4);
  }

  groundSlam(intensity: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.min(2, Math.max(0.5, intensity));
    this.tone(t, 1.2 * k, 80, 22, 1);
    this.noiseBurst(t, 0.9 * k, 'lowpass', 700, 0.9);
    this.noiseBurst(t + 0.05, 2.5, 'lowpass', 180, 0.5);
  }

  glass(x: number, y: number, z: number, count: number) {
    if (!this.ctx || !this.gate('glass', 0.06)) return;
    const [t, g] = this.at(x, y, z);
    const k = Math.min(1, 0.3 + count * 0.08) * g;
    this.noiseBurst(t, 0.35, 'highpass', 3500, 0.6 * k);
    // A few tinkles of falling shards.
    for (let i = 0; i < 4; i++) {
      const f = 2500 + ((this.bursts * 977 + i * 613) % 3500);
      this.tone(t + 0.04 + i * 0.07, 0.12, f, f * 0.9, 0.12 * k);
    }
  }

  crack(x: number, y: number, z: number, glass: boolean) {
    if (!this.ctx || !this.gate('crack', 0.05)) return;
    const [t, g] = this.at(x, y, z);
    if (glass) this.noiseBurst(t, 0.1, 'highpass', 4000, 0.35 * g);
    else this.noiseBurst(t, 0.08, 'bandpass', 2200, 0.45 * g);
  }

  breakSound(x: number, y: number, z: number, mass: number, glass: boolean) {
    if (!this.ctx || !this.gate('break', 0.05)) return;
    if (glass) return; // glass:shatter covers it
    const [t, g] = this.at(x, y, z);
    const k = Math.min(1.2, 0.4 + mass / 8000) * g;
    this.tone(t, 0.35, 120, 40, 0.6 * k);
    this.noiseBurst(t, 0.45, 'lowpass', 1100, 0.6 * k);
  }

  /** A failing story: low groaning steel and concrete that builds until it goes. */
  creak(x: number, y: number, z: number, duration: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const [t, g] = this.at(x, y, z);
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(48, t);
    osc.frequency.linearRampToValueAtTime(34, t + duration);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 3.3;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 6;
    lfo.connect(lfoGain).connect(osc.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5 * g + 0.001, t + duration * 0.9);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.4);
    osc.connect(lp).connect(gain).connect(this.fxBus);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + duration + 0.5);
    lfo.stop(t + duration + 0.5);
    // Sharp cracks and pops scattered through the failure.
    for (let i = 0; i < 6; i++) {
      const at = t + (duration * (i + 0.5)) / 6;
      this.noiseBurst(at, 0.07, 'bandpass', 1800 + i * 300, 0.35 * g);
    }
  }

  /** Collapse: a long roar, then the rumble of it all coming down (heard after it's seen). */
  collapse(x: number, y: number, z: number) {
    if (!this.ctx) return;
    const [t, g] = this.at(x, y, z);
    const k = Math.max(0.35, g);
    this.noiseBurst(t, 6, 'lowpass', 420, 0.9 * k);
    this.tone(t, 5, 42, 24, 0.8 * k);
    this.noiseBurst(t + 1.5, 8, 'lowpass', 160, 0.7 * k);
  }

  crush(x: number, y: number, z: number, mass: number) {
    if (!this.ctx || !this.gate('crush', 0.07)) return;
    const [t, g] = this.at(x, y, z);
    const k = Math.min(1, 0.3 + mass / 400000) * Math.max(0.3, g);
    this.tone(t, 0.5, 70, 30, 0.6 * k);
    this.noiseBurst(t, 0.6, 'lowpass', 600, 0.6 * k);
  }

  /** Sonic boom: a hard double crack, then a deep thump rolling away. */
  boom() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noiseBurst(t, 0.09, 'highpass', 900, 1.0);
    this.noiseBurst(t + 0.11, 0.08, 'highpass', 700, 0.7);
    this.noiseBurst(t, 1.4, 'lowpass', 500, 0.9);
    this.tone(t, 1.2, 70, 28, 0.9);
  }

  thud(intensity: number, dive: boolean) {
    if (!this.ctx) return;
    const k = Math.min(1.5, Math.max(0.3, intensity)) * (dive ? 1.3 : 1);
    const t = this.ctx.currentTime;
    this.tone(t, 0.6 * k, 110, 32, 0.8 * Math.min(1, k));
    this.noiseBurst(t, 0.5 * k, 'lowpass', 900, 0.6 * Math.min(1, k));
    this.noiseBurst(t, 1.6 * k, 'lowpass', 220, 0.35); // debris settling
  }

  slam(intensity: number) {
    if (!this.ctx) return;
    const k = Math.min(1.5, Math.max(0.3, intensity));
    const t = this.ctx.currentTime;
    this.tone(t, 0.35, 160, 45, 0.7 * Math.min(1, k));
    this.noiseBurst(t, 0.3, 'bandpass', 1400, 0.6 * Math.min(1, k));
  }
}
