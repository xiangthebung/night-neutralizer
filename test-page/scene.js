/**
 * Synthetic test footage, drawn on a canvas so the repository needs no video
 * files. The cycle is designed to stress every part of the tone mapper:
 *
 *   0.0-3.0 s  night interior: almost everything below 12% luma, with a
 *              near-black gradient wedge that should become visible
 *   3.0-3.2 s  hard cut to a bright snow field (tests fast dimming)
 *   3.2-6.0 s  bright scene with a blown-out sky (tests highlight roll-off)
 *   6.0-9.0 s  slow fade back to the dark interior (tests slow recovery)
 *   9.0-9.1 s  single-frame white flash (tests the flash guard)
 *
 * A grey step wedge and a colour bar strip are drawn on top of every frame so
 * banding, black crush and hue shifts are easy to judge.
 */
/* global window */
function startScene(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  const speed = options.speed ?? 1;
  const width = canvas.width;
  const height = canvas.height;
  const start = performance.now();

  function drawWedge() {
    const steps = 16;
    const w = width / steps;
    for (let i = 0; i < steps; i++) {
      // Perceptual-ish spacing so the dark end has plenty of steps.
      const value = Math.round(255 * Math.pow(i / (steps - 1), 2.2));
      ctx.fillStyle = `rgb(${value},${value},${value})`;
      ctx.fillRect(i * w, height - 26, w, 14);
    }
    const hues = [0, 30, 60, 120, 200, 260, 300];
    const cw = width / hues.length;
    hues.forEach((hue, i) => {
      ctx.fillStyle = `hsl(${hue} 70% 45%)`;
      ctx.fillRect(i * cw, height - 12, cw, 12);
    });
  }

  function nightInterior(intensity) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, `rgb(${2 * intensity},${3 * intensity},${6 * intensity})`);
    gradient.addColorStop(1, `rgb(${16 * intensity},${14 * intensity},${20 * intensity})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    // Very dark shapes: invisible at low screen brightness, visible once the
    // shadows are lifted.
    for (let i = 0; i < 6; i++) {
      const level = Math.round((4 + i * 4) * intensity);
      ctx.fillStyle = `rgb(${level},${level},${level + 2})`;
      ctx.fillRect(40 + i * (width / 7), height * 0.3, width / 12, height * 0.35);
    }

    // A single small warm highlight (a lamp) to check it does not bloom.
    const lamp = ctx.createRadialGradient(width * 0.82, height * 0.28, 2, width * 0.82, height * 0.28, 60);
    lamp.addColorStop(0, `rgba(255,214,150,${0.85 * intensity})`);
    lamp.addColorStop(1, 'rgba(255,214,150,0)');
    ctx.fillStyle = lamp;
    ctx.fillRect(0, 0, width, height);
  }

  function snowField() {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, 'rgb(252,253,255)');
    sky.addColorStop(0.55, 'rgb(228,238,250)');
    sky.addColorStop(1, 'rgb(206,220,236)');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.beginPath();
    ctx.arc(width * 0.7, height * 0.22, 42, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgb(38,44,56)';
    ctx.beginPath();
    ctx.moveTo(0, height * 0.72);
    ctx.lineTo(width * 0.3, height * 0.5);
    ctx.lineTo(width * 0.62, height * 0.78);
    ctx.lineTo(0, height * 0.95);
    ctx.closePath();
    ctx.fill();
  }

  function frame() {
    const t = ((performance.now() - start) / 1000) * speed;
    const cycle = t % 9.4;

    ctx.clearRect(0, 0, width, height);
    if (cycle < 3) {
      nightInterior(1);
    } else if (cycle < 6) {
      snowField();
    } else if (cycle < 9) {
      // Slow fade from bright back to dark.
      const k = (cycle - 6) / 3;
      snowField();
      ctx.fillStyle = `rgba(0,0,0,${k})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = k;
      nightInterior(k);
      ctx.globalAlpha = 1;
    } else if (cycle < 9.1) {
      ctx.fillStyle = 'rgb(255,255,255)';
      ctx.fillRect(0, 0, width, height);
    } else {
      nightInterior(1);
    }

    drawWedge();

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '13px system-ui, sans-serif';
    const label =
      cycle < 3
        ? 'night interior'
        : cycle < 6
          ? 'bright snow'
          : cycle < 9
            ? 'fade to night'
            : cycle < 9.1
              ? 'FLASH'
              : 'night interior';
    ctx.fillText(`${label}  t=${cycle.toFixed(1)}s`, 10, 20);

    window.requestAnimationFrame(frame);
  }

  window.requestAnimationFrame(frame);
  return canvas;
}

window.startScene = startScene;
