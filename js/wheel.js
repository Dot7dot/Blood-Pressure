// iPhone 鬧鐘風格的滾輪選擇器（scroll-snap + 3D 傾斜效果，可循環）
const COPIES = 9; // 循環欄位重複的份數

export class Wheel {
  /**
   * @param {HTMLElement} el
   * @param {string[]} labels
   * @param {{loop?: boolean, onChange?: (i:number)=>void, ariaText?: (i:number)=>string}} opts
   */
  constructor(el, labels, opts = {}) {
    this.el = el;
    this.labels = labels;
    this.n = labels.length;
    this.loop = !!opts.loop;
    this.onChange = opts.onChange || (() => {});
    this.ariaText = opts.ariaText || ((i) => labels[i]);
    this.copies = this.loop ? COPIES : 1;
    this.index = 0;
    this._raf = 0;
    this._settleTimer = 0;

    const track = document.createElement('div');
    track.className = 'wheel-track';
    const frag = document.createDocumentFragment();
    for (let c = 0; c < this.copies; c++) {
      labels.forEach((text, i) => {
        const item = document.createElement('div');
        item.className = 'wheel-item';
        item.textContent = text;
        item.dataset.pos = String(c * this.n + i);
        frag.appendChild(item);
      });
    }
    track.appendChild(frag);
    el.appendChild(track);
    this.items = Array.from(track.children);

    el.addEventListener('scroll', () => this._onScroll(), { passive: true });
    el.addEventListener('click', (e) => {
      const item = e.target.closest('.wheel-item');
      if (!item) return;
      el.scrollTo({ top: Number(item.dataset.pos) * this.itemH(), behavior: 'smooth' });
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.step(e.key === 'ArrowUp' ? -1 : 1);
      }
    });
    // 桌機滑鼠滾輪：一格一格移動，避免一次滑太遠
    el.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) < 1 || e.ctrlKey) return;
      e.preventDefault();
      const now = performance.now();
      if (this._lastWheel && now - this._lastWheel < 60) return;
      this._lastWheel = now;
      this.step(e.deltaY > 0 ? 1 : -1);
    }, { passive: false });
  }

  itemH() {
    return this.items[0].offsetHeight || 40;
  }

  get value() {
    return this.index;
  }

  /** 設定值（不觸發 onChange）。需在元素可見時呼叫。 */
  set(i, silent = true) {
    i = ((i % this.n) + this.n) % this.n;
    const mid = this.loop ? Math.floor(this.copies / 2) : 0;
    this.el.scrollTop = (mid * this.n + i) * this.itemH();
    this.index = i;
    this._paint();
    this._aria();
    if (!silent) this.onChange(i);
  }

  step(delta) {
    const pos = Math.round(this.el.scrollTop / this.itemH()) + delta;
    const max = this.items.length - 1;
    this.el.scrollTo({ top: Math.max(0, Math.min(max, pos)) * this.itemH(), behavior: 'smooth' });
  }

  _onScroll() {
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this._paint();
        const i = this._currentIndex();
        if (i !== this.index) {
          this.index = i;
          this._aria();
          this.onChange(i);
        }
      });
    }
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => this._settle(), 160);
  }

  _currentIndex() {
    const pos = Math.round(this.el.scrollTop / this.itemH());
    return ((pos % this.n) + this.n) % this.n;
  }

  _settle() {
    if (!this.loop) return;
    // 滑到靠近邊界時，無縫跳回中間那一份，達成「無限循環」
    const h = this.itemH();
    const pos = Math.round(this.el.scrollTop / h);
    const copy = Math.floor(pos / this.n);
    if (copy <= 1 || copy >= this.copies - 2) {
      const mid = Math.floor(this.copies / 2);
      this.el.scrollTop = (mid * this.n + (pos % this.n)) * h;
    }
  }

  _paint() {
    const h = this.itemH();
    const center = this.el.scrollTop / h;
    const from = Math.max(0, Math.floor(center) - 4);
    const to = Math.min(this.items.length - 1, Math.ceil(center) + 4);
    // 只更新可見範圍附近的項目
    if (this._painted) {
      for (const idx of this._painted) {
        if (idx < from || idx > to) {
          const it = this.items[idx];
          it.style.transform = '';
          it.style.opacity = '';
          it.classList.remove('sel');
        }
      }
    }
    this._painted = [];
    for (let idx = from; idx <= to; idx++) {
      const d = idx - center;
      const it = this.items[idx];
      const ad = Math.min(Math.abs(d), 3);
      it.style.transform = `perspective(500px) rotateX(${(-d * 20).toFixed(1)}deg) scale(${(1 - ad * 0.06).toFixed(3)})`;
      it.style.opacity = String(Math.max(0.15, 1 - ad * 0.3).toFixed(2));
      it.classList.toggle('sel', Math.abs(d) < 0.5);
      this._painted.push(idx);
    }
  }

  _aria() {
    this.el.setAttribute('aria-valuetext', this.ariaText(this.index));
    this.el.setAttribute('aria-valuenow', String(this.index));
  }
}
