/**
 * A Source is anything that can list and read the files of a PhysiCell output
 * folder. Two implementations: one over HTTP (a served directory) and one over
 * a local folder the user picked in the file dialog or dropped on the window.
 */

/** @typedef {{label:string, list():Promise<string[]>, text(name:string):Promise<string>, bytes(name:string):Promise<ArrayBuffer>, has(name:string):boolean|undefined}} Source */

/** Files served over HTTP from a directory URL. */
export class HttpSource {
  /** @param {string} baseUrl directory URL, with or without trailing slash */
  constructor(baseUrl) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.label = this.baseUrl;
    this._names = null;
    // True only when the listing is authoritative. Probing finds frames but
    // cannot see cell_lineage.csv or the microenvironment files, so has() must
    // answer "don't know" rather than "no" and let the fetch decide.
    this._listingComplete = false;
  }

  url(name) {
    return new URL(encodeURIComponent(name), new URL(this.baseUrl, location.href)).href;
  }

  async _fetch(name, kind) {
    const res = await fetch(this.url(name));
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${name}`);
    return kind === 'text' ? res.text() : res.arrayBuffer();
  }

  text(name) { return this._fetch(name, 'text'); }
  bytes(name) { return this._fetch(name, 'bytes'); }
  has(name) {
    if (!this._names) return undefined;
    if (this._names.has(name)) return true;
    return this._listingComplete ? false : undefined;
  }

  /**
   * Directory listings are not a web standard, so try three strategies in
   * order: an index.json we can generate, the HTML listing that most static
   * servers (including `python3 -m http.server`) emit, and finally probing
   * for the numbered frame files directly.
   */
  async list() {
    if (this._names) return [...this._names];
    let names = await this._listIndexJson();
    if (!names) names = await this._listHtml();
    this._listingComplete = names !== null;
    if (!names) names = await this._listByProbing();
    this._names = new Set(names);
    return names;
  }

  async _listIndexJson() {
    try {
      const res = await fetch(this.url('index.json'));
      if (!res.ok) return null;
      const data = await res.json();
      const names = Array.isArray(data) ? data : data.files;
      return Array.isArray(names) ? names.map(String) : null;
    } catch {
      return null;
    }
  }

  async _listHtml() {
    try {
      const res = await fetch(new URL(this.baseUrl, location.href).href);
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (!type.includes('html')) return null;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const names = [];
      for (const a of doc.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href');
        if (!href || href.startsWith('?') || href.startsWith('/') || href.includes('://')) continue;
        const name = decodeURIComponent(href.replace(/\/$/, ''));
        if (name && name !== '..' && !name.includes('/')) names.push(name);
      }
      return names.length ? names : null;
    } catch {
      return null;
    }
  }

  /** Last resort: HEAD-probe output00000000.xml, output00000001.xml, ... */
  async _listByProbing(maxFrames = 100000) {
    const names = [];
    for (const name of ['initial.xml', 'final.xml']) {
      if (await this._exists(name)) names.push(name);
    }
    let misses = 0;
    for (let i = 0; i < maxFrames; i++) {
      const name = `output${String(i).padStart(8, '0')}.xml`;
      if (await this._exists(name)) {
        names.push(name);
        misses = 0;
      } else if (++misses >= 3) {
        break; // tolerate a couple of gaps, then assume the run ended
      }
    }
    return names;
  }

  async _exists(name) {
    try {
      const res = await fetch(this.url(name), { method: 'HEAD' });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** Files from a directory the user picked locally; nothing leaves the browser. */
export class FileSource {
  /** @param {File[]|FileList} files */
  constructor(files, label = 'local folder') {
    this.files = new Map();
    let root = null;
    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      const name = path.slice(path.lastIndexOf('/') + 1);
      this.files.set(name, file);
      if (root === null && file.webkitRelativePath) root = path.slice(0, path.indexOf('/'));
    }
    this.label = root || label;
  }

  async list() { return [...this.files.keys()]; }
  has(name) { return this.files.has(name); }

  _get(name) {
    const file = this.files.get(name);
    if (!file) throw new Error(`${name} is not in the selected folder`);
    return file;
  }

  text(name) { return this._get(name).text(); }
  bytes(name) { return this._get(name).arrayBuffer(); }
}
