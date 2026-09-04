/**
 * 지휘 비트 검출기 검증 — node prototypes/beat-detector.test.js
 *
 * silent-night-conductor-fixed.html 의 detectBeat() 와 동일한 로직을
 * 합성 손동작에 통과시켜, 카메라 없이도 다음을 확인한다.
 *
 *   1. 프레임레이트가 바뀌어도 같은 동작이 같은 결과를 내는가  (원본의 B1 버그)
 *   2. 느린 지휘부터 빠른 지휘까지 박자를 정확히 세는가
 *   3. 손떨림·드리프트·정지에서 오발사하지 않는가
 *   4. 한 번의 스트로크에서 두 번 울리지 않는가
 *   5. 스트로크 바닥 시점에 맞춰 울리는가
 *
 * 검출기 로직을 손대면 반드시 이 파일을 먼저 돌려볼 것.
 */

const TAU = 45, COOLDOWN = 200, RATIO = 0.45, PEAK_DECAY = 1200, ARM_V = 0.08;
const SENS = [0.80, 0.55, 0.38, 0.27, 0.20];

// 지휘 동작: 손이 내려갔다 올라온다 (bpm회/분, amp = 화면높이 대비 진폭)
const handY = (t, bpm, amp) => 0.5 - amp * Math.cos(2 * Math.PI * (bpm / 60) * t);
// 손떨림: 생리적 진전은 대략 8~12Hz, 진폭은 매우 작다
const tremor = t => 0.004 * Math.sin(t * 57) + 0.003 * Math.sin(t * 91);
// 스트로크 바닥은 t=(k+0.5)/f 에 온다 → 구간 내 개수
const expect = (dur, bpm) => Math.floor(dur * (bpm / 60) + 0.5);

function run(fps, sensIdx, dur, yfn) {
  const s = { y: null, peak: 0, last: -1e9, lastT: 0, armed: true };
  const sens = SENS[sensIdx], step = 1000 / fps, times = [];
  for (let t = 0; t <= dur * 1000; t += step) {
    const yRaw = yfn(t / 1000);
    if (s.y === null) { s.y = yRaw; s.lastT = t; continue; }
    const dt = Math.min(100, Math.max(1, t - s.lastT)); s.lastT = t;
    const y = s.y + (yRaw - s.y) * (1 - Math.exp(-dt / TAU));
    const v = (y - s.y) / (dt / 1000);
    s.y = y;
    if (v < 0) s.peak = 0;
    if (v < -ARM_V) s.armed = true;
    if (v > s.peak) s.peak = v; else s.peak *= Math.exp(-dt / PEAK_DECAY);
    if (s.armed && s.peak > sens && v < s.peak * RATIO && (t - s.last) > COOLDOWN) {
      s.last = t; s.peak = 0; s.armed = false; times.push(t);
    }
  }
  return times;
}

let pass = 0, fail = 0;
const chk = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); c ? pass++ : fail++; };

console.log('\n[1] 프레임레이트 독립성 (감도3, 60BPM, 10초 → 10번)');
for (const amp of [0.20, 0.12, 0.08]) {
  const r = [24, 30, 60, 120].map(f => run(f, 2, 10, t => handY(t, 60, amp)).length);
  chk(r.every(n => n === 10), `진폭 ${amp} → [${r.join(', ')}]`);
}

console.log('\n[2] 템포 범위 (감도3, 60fps, 진폭0.12)');
for (const bpm of [40, 50, 60, 90, 120, 150]) {
  const e = expect(10, bpm), n = run(60, 2, 10, t => handY(t, bpm, 0.12)).length;
  chk(n === e, `${bpm}BPM → ${n}번 (정답 ${e})`);
}

console.log('\n[3] 오발사 검사 (감도5 — 가장 민감)');
for (const [fn, l] of [[t => 0.5 + tremor(t), '손떨림'],
                       [t => 0.3 + 0.04 * t, '느린 드리프트'],
                       [() => 0.5, '완전 정지']]) {
  const n = run(60, 4, 10, fn).length;
  chk(n === 0, `${l} → ${n}번`);
}

console.log('\n[4] 지휘 + 손떨림 동시 (감도3 → 10번)');
for (const amp of [0.20, 0.12, 0.08]) {
  const n = run(60, 2, 10, t => handY(t, 60, amp) + tremor(t)).length;
  chk(n === 10, `진폭 ${amp} → ${n}번`);
}

console.log('\n[5] 한 스트로크에 한 번만 (진폭0.20 → 10번)');
for (let si = 0; si < 5; si++) {
  const n = run(60, si, 10, t => handY(t, 60, 0.20)).length;
  chk(n === 10, `감도${si + 1} → ${n}번`);
}

console.log('\n[6] 발사 시점 정확도 (바닥 = 0.5s 간격)');
for (const f of [24, 30, 60, 120]) {
  const t = run(f, 2, 3, x => handY(x, 60, 0.12));
  const err = Math.max(...t.map((x, i) => Math.abs(x - (500 + i * 1000))));
  chk(err <= 50, `${String(f).padStart(3)}fps 최대오차 ${err.toFixed(0)}ms`);
}

console.log(`\n${'='.repeat(46)}\n통과 ${pass} / 실패 ${fail}\n`);
process.exit(fail ? 1 : 0);
