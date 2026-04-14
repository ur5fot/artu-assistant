export interface AlarmAudio {
  startLoop(): void;
  stopLoop(): void;
}

export function createAlarmAudio(): AlarmAudio {
  let ctx: AudioContext | null = null;
  let osc: OscillatorNode | null = null;
  let gain: GainNode | null = null;
  let pulseTimer: number | null = null;
  let active = false;

  return {
    startLoop() {
      if (active) return;
      active = true;
      const AudioContextCtor: typeof AudioContext =
        (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
          .AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioContextCtor();
      if (ctx.state === 'suspended') {
        void ctx.resume();
      }
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.type = 'sine';
      gain.gain.value = 0;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      let on = false;
      pulseTimer = window.setInterval(() => {
        on = !on;
        if (gain) gain.gain.value = on ? 0.2 : 0;
      }, 500);
    },

    stopLoop() {
      if (!active) return;
      active = false;
      if (pulseTimer !== null) {
        window.clearInterval(pulseTimer);
        pulseTimer = null;
      }
      try { osc?.stop(); } catch { /* already stopped */ }
      osc?.disconnect();
      gain?.disconnect();
      void ctx?.close();
      osc = null;
      gain = null;
      ctx = null;
    },
  };
}
