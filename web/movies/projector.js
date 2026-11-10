// A perspective camera projects three PCA coordinates onto a canvas.
// Ranking remains in the original embedding space.
export class MovieProjector {
  constructor(canvas, movies, onSelect) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.movies = movies;
    this.byId = new Map(movies.map(movie => [movie.id, movie]));
    this.labels = document.getElementById('space-labels');
    this.tooltip = document.getElementById('space-tooltip');
    this.onSelect = onSelect;
    this.selected = new Set();
    this.suggestions = new Set();
    this.showSuggestions = false;
    this.rotation = {
      x: -.15,
      y: -.35
    };
    this.distance = 3.4;
    this.center = [0, 0, 0];
    this.target = [0, 0, 0];
    this.autoRotate = false;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.screenPoints = [];
    this.bindControls();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    this.frame = now => {
      const elapsed = Math.min((now - (this.previousFrame || now)) / 1000, .05);
      this.previousFrame = now;
      if (this.autoRotate && !this.drag) this.rotation.y += elapsed * .075;
      this.center = this.center.map((value, axis) => value + (this.target[axis] - value) * (this.reducedMotion ? 1 : .1));
      this.draw(now);
      this.animation = requestAnimationFrame(this.frame);
    };
    this.animation = requestAnimationFrame(this.frame);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  project(point) {
    const [x, y, z] = point.map((value, axis) => value - this.center[axis]);
    const yaw = this.rotation.y,
      pitch = this.rotation.x;
    const horizontal = x * Math.cos(yaw) + z * Math.sin(yaw);
    const away = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const vertical = y * Math.cos(pitch) - away * Math.sin(pitch);
    const depth = this.distance - (y * Math.sin(pitch) + away * Math.cos(pitch));
    const scale = Math.min(this.width, this.height) * 1.15 / Math.max(.15, depth);
    return {
      x: this.width / 2 + horizontal * scale,
      y: this.height * .49 - vertical * scale,
      depth,
      scale
    };
  }

  update(profile, results) {
    this.selected = new Set(Object.entries(profile).filter(([, entry]) => entry.status).map(([id]) => id));
    this.suggestions = new Set(results.map(item => item.movie.id));
    this.updateLabels();
  }

  setSuggestions(visible) {
    this.showSuggestions = visible;
    this.updateLabels();
  }

  focus(id) {
    const movie = this.byId.get(id);
    if (!movie) return;
    this.focused = id;
    this.pulseStarted = performance.now();
    this.target = movie.projection.map(value => value * .65);
    this.updateLabels();
  }

  reset() {
    this.rotation = {
      x: -.15,
      y: -.35
    };
    this.distance = 3.4;
    this.target = [0, 0, 0];
  }

  updateLabels() {
    const ids = [...this.selected].slice(-6);
    if (this.showSuggestions) ids.push(...[...this.suggestions].slice(0, 4));
    if (this.focused && !ids.includes(this.focused)) ids.push(this.focused);
    this.labels.replaceChildren();
    this.labelNodes = [];
    for (const id of [...new Set(ids)]) {
      const movie = this.byId.get(id);
      if (!movie) continue;
      const label = document.createElement('span');
      label.className = `point-label${this.selected.has(id) ? '' : this.showSuggestions && this.suggestions.has(id) ? ' recommended' : ' focused'}`;
      label.textContent = movie.title;
      this.labels.append(label);
      this.labelNodes.push({
        id,
        label
      });
    }
  }

  draw(now) {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    // A faint floor gives rotation and depth a stable visual reference.
    ctx.strokeStyle = '#28435833';
    ctx.lineWidth = .6;
    for (let step = -4; step <= 4; step++) {
      for (const line of [
          [
            [-1.2, -1, step * .3],
            [1.2, -1, step * .3]
          ],
          [
            [step * .3, -1, -1.2],
            [step * .3, -1, 1.2]
          ]
        ]) {
        const [a, b] = line.map(point => this.project(point));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    this.screenPoints = this.movies.map(movie => ({
      movie,
      ...this.project(movie.projection)
    })).sort((a, b) => b.depth - a.depth);
    const highlighted = [];
    for (const point of this.screenPoints) {
      if (point.depth <= .15) continue;
      if (this.selected.has(point.movie.id) || (this.showSuggestions && this.suggestions.has(point.movie.id)) || point.movie.id === this.focused) {
        highlighted.push(point);
        continue;
      }
      const opacity = Math.max(.18, Math.min(.75, 1.6 / point.depth));
      ctx.fillStyle = `rgba(91,145,178,${opacity})`;
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(.8, Math.min(2.5, point.scale * .008)), 0, Math.PI * 2);
      ctx.fill();
    }
    for (const point of highlighted) {
      const selected = this.selected.has(point.movie.id);
      const recommended = this.showSuggestions && this.suggestions.has(point.movie.id);
      const color = selected ? '#f3c66b' : recommended ? '#8aebc5' : '#e3edf5';
      const radius = selected ? 4.4 : 3.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 14;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (point.movie.id === this.focused) {
        const pulse = this.reducedMotion ? 0 : ((now - this.pulseStarted) % 1800) / 1800;
        ctx.strokeStyle = color;
        ctx.globalAlpha = .65 * (1 - pulse);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8 + pulse * 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    const positions = new Map(this.screenPoints.map(point => [point.movie.id, point]));
    const occupied = [];
    for (const {
        id,
        label
      }
      of this.labelNodes || []) {
      const point = positions.get(id);
      const x = point.x + 10,
        y = point.y - 20;
      const collides = occupied.some(rect => Math.abs(rect.x - x) < 155 && Math.abs(rect.y - y) < 28);
      label.hidden = point.depth <= .15 || x < 0 || x > this.width - 130 || y < 70 || y > this.height - 75 || (collides && id !== this.focused);
      if (!label.hidden) {
        label.style.transform = `translate(${x}px,${y}px)`;
        occupied.push({
          x,
          y
        });
      }
    }
  }

  pick(x, y) {
    let closest, minimum = 10;
    for (const point of this.screenPoints) {
      if (point.depth <= .15) continue;
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance < minimum) {
        closest = point;
        minimum = distance;
      }
    }
    return closest;
  }

  bindControls() {
    this.canvas.addEventListener('pointerdown', event => {
      this.drag = {
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY
      };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener('pointermove', event => {
      if (this.drag) {
        this.rotation.y += (event.clientX - this.drag.x) * .006;
        this.rotation.x = Math.max(-1.4, Math.min(1.4, this.rotation.x + (event.clientY - this.drag.y) * .006));
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        this.tooltip.hidden = true;
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const x = event.clientX - rect.left,
        y = event.clientY - rect.top;
      const point = this.pick(x, y);
      this.canvas.style.cursor = point ? 'pointer' : 'grab';
      this.tooltip.hidden = !point;
      if (point) {
        this.tooltip.textContent = `${point.movie.title} (${point.movie.year})`;
        this.tooltip.style.left = `${Math.min(x + 13, this.width - 210)}px`;
        this.tooltip.style.top = `${Math.max(75, y - 35)}px`;
      }
    });
    this.canvas.addEventListener('pointerup', event => {
      if (this.drag && Math.hypot(event.clientX - this.drag.startX, event.clientY - this.drag.startY) < 5) {
        const rect = this.canvas.getBoundingClientRect();
        const point = this.pick(event.clientX - rect.left, event.clientY - rect.top);
        if (point) {
          this.focus(point.movie.id);
          this.onSelect(point.movie.id);
        }
      }
      this.drag = null;
    });
    this.canvas.addEventListener('pointercancel', () => {
      this.drag = null;
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.tooltip.hidden = true;
    });
    this.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      this.distance = Math.max(1.6, Math.min(7, this.distance + event.deltaY * .002));
    }, {
      passive: false
    });
    this.canvas.addEventListener('keydown', event => {
      const actions = {
        ArrowLeft: () => {
          this.rotation.y -= .1;
        },
        ArrowRight: () => {
          this.rotation.y += .1;
        },
        ArrowUp: () => {
          this.rotation.x -= .1;
        },
        ArrowDown: () => {
          this.rotation.x += .1;
        },
        '+': () => {
          this.distance = Math.max(1.6, this.distance - .2);
        },
        '-': () => {
          this.distance = Math.min(7, this.distance + .2);
        },
        Home: () => this.reset(),
        Enter: () => {
          if (this.focused) this.onSelect(this.focused);
        }
      };
      if (actions[event.key]) {
        event.preventDefault();
        actions[event.key]();
      }
    });
  }
}