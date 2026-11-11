// HUD: speed, street name, heading-up minimap.

export class Hud {
  constructor(root, world) {
    this.world = world;
    this.speedEl = root.querySelector('#speed-val');
    this.gearEl = root.querySelector('#gear');
    this.streetEl = root.querySelector('#street');
    this.msgEl = root.querySelector('#msg');
    this.camEl = root.querySelector('#cam-name');
    this.statsEl = root.querySelector('#stats');
    this.mapCanvas = root.querySelector('#minimap');
    this.ctx = this.mapCanvas.getContext('2d');
    this.street = '';
    this.streetTimer = 0;
    this.msgTimer = 0;
    this.lastSpeed = -1;
    this.resizeMap();
    addEventListener('resize', () => this.resizeMap());
  }

  resizeMap() {
    const css = this.mapCanvas.clientWidth || 150;
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.mapCanvas.width = this.mapCanvas.height = Math.round(css * dpr);
    this.mapPx = css;
    this.mapDpr = dpr;
  }

  message(text, secs = 2) {
    this.msgEl.textContent = text;
    this.msgEl.classList.add('show');
    this.msgTimer = secs;
  }

  update(dt, car) {
    const kmh = Math.round(car.speed * 3.6);
    if (kmh !== this.lastSpeed) { this.speedEl.textContent = kmh; this.lastSpeed = kmh; }
    const gear = car.vF < -0.5 ? 'R' : car.surface === 'road' || car.surface === 'paved' ? 'D' : 'D · off-road';
    if (this.gearEl.textContent !== gear) this.gearEl.textContent = gear;

    // street name: throttled lookup
    this.streetTimer -= dt;
    if (this.streetTimer <= 0) {
      this.streetTimer = 0.25;
      const near = this.world.nearestRoad(car.x, car.y, 14, (r) => r.c < 8 || r.n !== undefined);
      let name = '';
      if (near) name = near.road.n !== undefined ? this.world.data.names[near.road.n] : near.road.c === 6 ? 'Service lane' : 'Unnamed road';
      else name = car.surface === 'sand' ? 'Beach' : car.surface === 'water' ? 'In the water!' : 'Off road';
      if (name !== this.street) { this.street = name; this.streetEl.textContent = name; }
    }
    if (this.msgTimer > 0) {
      this.msgTimer -= dt;
      if (this.msgTimer <= 0) this.msgEl.classList.remove('show');
    }
    this.drawMap(car);
  }

  drawMap(car) {
    const g = this.ctx;
    const M = this.world.minimap;
    const W = this.mapCanvas.width;
    const r = W / 2;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath();
    g.arc(r, r, r - 1, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#4f9ccc';
    g.fillRect(0, 0, W, W);
    // metres shown across the radius grows a little with speed
    const radiusM = 260 + Math.min(260, car.speed * 6);
    const scale = r / radiusM * M.mpp; // canvas px per map image px
    const u = (car.renderX - M.x0) / M.mpp, v = (M.y1 - car.renderY) / M.mpp;
    g.translate(r, r);
    g.rotate(-car.renderHeading);
    g.scale(scale, scale);
    g.translate(-u, -v);
    g.imageSmoothingEnabled = true;
    g.drawImage(M.canvas, 0, 0);
    g.restore();
    // player arrow (always pointing up)
    g.save();
    g.translate(r, r);
    const s = W / 150;
    g.fillStyle = '#ff6a2a';
    g.strokeStyle = '#fff';
    g.lineWidth = 2 * s;
    g.beginPath();
    g.moveTo(0, -9 * s); g.lineTo(6.5 * s, 7 * s); g.lineTo(0, 3.5 * s); g.lineTo(-6.5 * s, 7 * s); g.closePath();
    g.fill(); g.stroke();
    g.restore();
    // north marker on the rim
    g.save();
    g.translate(r, r);
    g.rotate(-car.renderHeading);
    g.fillStyle = '#fff';
    g.font = `bold ${11 * s}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', 0, -r + 10 * s);
    g.restore();
  }
}
