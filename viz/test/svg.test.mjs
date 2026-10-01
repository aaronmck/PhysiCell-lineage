import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSVG } from '../src/render/svgExport.js';

/**
 * Camera at the origin looking down -z (identity view), 90° fov, square
 * aspect: a cell at distance d with radius r projects to r/d * (height/2)
 * pixels, centred when it sits on the axis.
 */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function perspective(near = 1, far = 1000) {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, -(far + near) / (far - near), -1,
    0, 0, (-2 * far * near) / (far - near), 0,
  ];
}

function scene({ positions, radii, colors, flags = null, ...rest }) {
  return renderSVG({
    width: 200,
    height: 200,
    view: IDENTITY,
    projection: perspective(),
    positions: Float32Array.from(positions),
    radii: Float32Array.from(radii),
    colors: Float32Array.from(colors),
    flags: flags ? Uint8Array.from(flags) : null,
    count: radii.length,
    ...rest,
  });
}

test('projects a centred cell to the middle of the viewport', () => {
  const svg = scene({ positions: [0, 0, -100], radii: [10], colors: [1, 0, 0] });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="200" height="200"/);
  assert.ok(svg.includes('<rect width="200" height="200" fill="#ffffff"/>'), 'white background rect');
  assert.ok(svg.includes('<circle cx="100" cy="100" r="10" fill="#ff0000"/>'), `got: ${svg}`);
  assert.ok(svg.includes('fill="url(#shade)"'), 'shading overlay for a large-enough circle');
  assert.ok(svg.endsWith('</svg>'));
});

test('paints back to front', () => {
  const svg = scene({
    positions: [-20, 0, -150, 20, 0, -50],
    radii: [10, 10],
    colors: [1, 0, 0, 0, 0, 1],
  });
  const far = svg.indexOf('#ff0000');
  const near = svg.indexOf('#0000ff');
  assert.ok(far >= 0 && near >= 0);
  assert.ok(far < near, 'the farther (red) cell is drawn before the nearer (blue) one');
});

test('skips hidden cells and cells behind the camera', () => {
  const svg = scene({
    positions: [0, 0, -100, 0, 0, -100, 0, 0, 100],
    radii: [10, 10, 10],
    colors: [1, 0, 0, 0, 0, 1, 0, 1, 0],
    flags: [4, 0, 0], // first is FLAG_HIDDEN, third sits behind the camera
  });
  assert.ok(!svg.includes('#ff0000'), 'hidden cell is not drawn');
  assert.ok(!svg.includes('#00ff00'), 'cell behind the camera is not drawn');
  assert.ok(svg.includes('#0000ff'));
});

test('dimmed cells fade toward the background', () => {
  const svg = scene({
    positions: [0, 0, -100],
    radii: [10],
    colors: [1, 0, 0],
    flags: [2], // FLAG_DIMMED, default dim 0.86 toward white
  });
  assert.ok(svg.includes('#ffdbdb'), `got: ${svg}`);
});

test('selected cells carry an outline', () => {
  const svg = scene({
    positions: [0, 0, -100],
    radii: [10],
    colors: [1, 0, 0],
    flags: [1], // FLAG_SELECTED
    selection: '#c77700',
  });
  assert.ok(svg.includes('stroke="#c77700"'));
});

test('the section plane drops cells by centre', () => {
  const svg = scene({
    positions: [0, 30, -100, 0, -30, -100],
    radii: [10, 10],
    colors: [1, 0, 0, 0, 0, 1],
    clip: { normal: [0, 1, 0], constant: 0 }, // keep y >= 0
  });
  assert.ok(svg.includes('#ff0000'));
  assert.ok(!svg.includes('#0000ff'));
});

test('depth cueing mixes distant cells toward the background', () => {
  const svg = scene({
    positions: [0, 0, -200],
    radii: [20],
    colors: [1, 0, 0],
    fog: { strength: 1, near: 100, far: 300 }, // smoothstep(100,300,200) = 0.5
  });
  assert.ok(svg.includes('#ff8080'), `got: ${svg}`);
});

test('draws the domain box and parent links', () => {
  const svg = scene({
    positions: [0, 20, -100, 0, -20, -100],
    radii: [10, 10],
    colors: [1, 0, 0, 0, 0, 1],
    box: { bbox: [-50, -50, -150, 50, 50, -60], color: '#a9a9a4' },
    links: {
      a: Int32Array.from([0]),
      b: Int32Array.from([1]),
      extra: new Float32Array(0),
      count: 1,
      opacity: 0.5,
      onTop: true,
    },
  });
  assert.ok(svg.includes('stroke="#a9a9a4"'), 'box edges');
  assert.ok(svg.includes('stroke-opacity="0.5"'), 'link group');
  // The link runs between the two projected centres and wears the child colour.
  assert.ok(/<line x1="100" y1="80" x2="100" y2="120" stroke="#ff0000"\/>/.test(svg), `got: ${svg}`);
});

test('an empty frame still yields a valid document', () => {
  const svg = scene({ positions: [], radii: [], colors: [] });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
});
