import { useEffect, useRef } from 'react';
import { BUTTONS } from '../lang/robotc-api';
import { Simulation } from '../sim/simulation';
import { capturePointer } from './viewport';

/** The EV3 LCD is 178×128 with 16 text lines; it is shown 1.75× larger so the text is readable. */
const LCD_SCALE = 1.75;
const LCD_W = Math.round(178 * LCD_SCALE);
const LCD_H = Math.round(128 * LCD_SCALE);
const LINE_H = 8 * LCD_SCALE;
const SMALL_FONT = '12px monospace';
const BIG_FONT = 'bold 18px monospace';

const LED_CLASS: Record<number, string> = {
  0: 'off',
  1: 'green',
  2: 'red',
  3: 'orange',
  4: 'green flash',
  5: 'red flash',
  6: 'orange flash',
  7: 'green pulse',
  8: 'red pulse',
  9: 'orange pulse',
};

function drawLcd(canvas: HTMLCanvasElement, sim: Simulation) {
  // draw at the screen's pixel density so the text stays sharp
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(LCD_W * dpr)) {
    canvas.width = Math.round(LCD_W * dpr);
    canvas.height = Math.round(LCD_H * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#c5cfa6';
  ctx.fillRect(0, 0, LCD_W, LCD_H);
  ctx.fillStyle = '#1b2410';
  ctx.textBaseline = 'middle';
  sim.lcd.forEach((l, k) => {
    if (!l) return;
    ctx.font = l.big ? BIG_FONT : SMALL_FONT;
    const w = ctx.measureText(l.text).width;
    const x = l.centered ? Math.max(0, (LCD_W - w) / 2) : 2;
    // a big line takes two small lines
    const y = k * LINE_H + (l.big ? LINE_H : LINE_H / 2);
    ctx.fillText(l.text, x, y);
  });
}

/** The EV3 brick: LCD, status light and the six buttons. */
export function BrickPanel({ sim }: { sim: Simulation }) {
  const lcdRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (lcdRef.current) drawLcd(lcdRef.current, sim);
  });

  const press = (b: number) => (e: React.PointerEvent) => {
    capturePointer(e);
    sim.buttons.add(b);
  };
  const release = (b: number) => () => sim.buttons.delete(b);
  const btn = (b: number, cls: string, label: string) => (
    <button
      className={`brick-btn ${cls}`}
      onPointerDown={press(b)}
      onPointerUp={release(b)}
      onPointerCancel={release(b)}
      aria-label={label}
      title={label}
    />
  );

  return (
    <div className="brick" dir="ltr">
      <canvas ref={lcdRef} className="lcd" style={{ width: LCD_W, height: LCD_H }} />
      <div className="brick-buttons">
        {btn(BUTTONS.buttonBack, 'back', 'buttonBack')}
        <div className={`led ${LED_CLASS[sim.led] ?? 'off'}`}>
          {btn(BUTTONS.buttonUp, 'up', 'buttonUp')}
          {btn(BUTTONS.buttonLeft, 'left', 'buttonLeft')}
          {btn(BUTTONS.buttonEnter, 'enter', 'buttonEnter')}
          {btn(BUTTONS.buttonRight, 'right', 'buttonRight')}
          {btn(BUTTONS.buttonDown, 'down', 'buttonDown')}
        </div>
      </div>
    </div>
  );
}
