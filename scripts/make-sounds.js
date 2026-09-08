'use strict';
// 生成内置音效（16bit / 22050Hz 单声道 WAV）。素材库自带，离线可用。
const fs = require('fs');
const path = require('path');

const RATE = 22050;
const OUT = path.join(__dirname, '..', 'library', 'sounds');

function wav (samples) {
    const n = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(RATE, 24);
    buf.writeUInt32LE(RATE * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        buf.writeInt16LE(Math.round(v * 32000), 44 + i * 2);
    }
    return buf;
}

// freq: t -> Hz, env: t -> 0..1
function render (duration, freq, env, harmonics = [1]) {
    const n = Math.floor(RATE * duration);
    const out = new Float32Array(n);
    let phase = 0;
    for (let i = 0; i < n; i++) {
        const t = i / RATE;
        phase += (2 * Math.PI * freq(t)) / RATE;
        let v = 0;
        let norm = 0;
        harmonics.forEach((amp, k) => {
            v += amp * Math.sin(phase * (k + 1));
            norm += Math.abs(amp);
        });
        out[i] = (v / norm) * env(t / duration) * 0.85;
    }
    return out;
}

const decay = k => x => Math.exp(-k * x);
const pluck = k => x => Math.min(1, x * 40) * Math.exp(-k * x);

const sounds = {
    ding: render(0.55, () => 1046, pluck(6), [1, 0.35, 0.15]),
    pop: render(0.14, t => 700 - 1600 * t, pluck(26), [1, 0.4]),
    jump: render(0.24, t => 240 + 1500 * t, pluck(8), [1, 0.3]),
    whoosh: render(0.42, t => 300 + 1400 * Math.sin((Math.PI * t) / 0.42), x => Math.sin(Math.PI * x), [1, 0.5, 0.25]),
    drum: render(0.34, t => 150 * Math.exp(-8 * t) + 55, pluck(11), [1, 0.5]),
    meow: render(0.5, t => 560 + 260 * Math.sin(9 * t) + 300 * Math.max(0, 0.18 - t) * 4, x => Math.sin(Math.PI * Math.pow(x, 0.8)), [1, 0.6, 0.3, 0.15])
};

// 过关：上行琶音；失败：下行
function arpeggio (notes, noteDur) {
    const out = new Float32Array(Math.floor(RATE * noteDur * notes.length));
    notes.forEach((f, idx) => {
        const seg = render(noteDur, () => f, pluck(5), [1, 0.3, 0.12]);
        out.set(seg.subarray(0, out.length - idx * Math.floor(RATE * noteDur)), idx * Math.floor(RATE * noteDur));
    });
    return out;
}

sounds.win = arpeggio([523, 659, 784, 1046], 0.13);
sounds.lose = arpeggio([392, 330, 262, 196], 0.15);

fs.mkdirSync(OUT, { recursive: true });
for (const [name, data] of Object.entries(sounds)) {
    fs.writeFileSync(path.join(OUT, `${name}.wav`), wav(data));
    console.log('生成', `${name}.wav`);
}
