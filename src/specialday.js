// v2.6.0: Special-day icons.
// The toolbar icon (and the logo on extension pages) changes on a few
// celebration days, based on the date and the region guessed from the
// computer's time zone. Nothing is sent anywhere; the calendar lives here.
// On 10 November (Turkey) the logo turns black and white for the day.
(function (root) {
  'use strict';

  const US_TZ = /^(America\/(New_York|Detroit|Kentucky\/|Indiana\/|Chicago|Menominee|North_Dakota\/|Denver|Boise|Phoenix|Los_Angeles|Anchorage|Juneau|Sitka|Metlakatla|Yakutat|Nome|Adak)|Pacific\/Honolulu|US\/)/;
  const BR_TZ = /^America\/(Sao_Paulo|Rio_Branco|Manaus|Porto_Velho|Boa_Vista|Cuiaba|Campo_Grande|Belem|Fortaleza|Recife|Bahia|Maceio|Araguaina|Santarem|Noronha|Eirunepe)$/;
  const MX_TZ = /^(America\/(Mexico_City|Monterrey|Merida|Matamoros|Chihuahua|Ciudad_Juarez|Ojinaga|Hermosillo|Mazatlan|Bahia_Banderas|Cancun|Tijuana)|Mexico\/)/;

  function region(tz) {
    try { tz = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { tz = ''; }
    if (tz === 'Europe/Istanbul' || tz === 'Asia/Istanbul' || tz === 'Turkey') return 'TR';
    if (tz === 'Asia/Tokyo' || tz === 'Japan') return 'JP';
    if (US_TZ.test(tz)) return 'US';
    if (BR_TZ.test(tz) || /^Brazil\//.test(tz)) return 'BR';
    if (MX_TZ.test(tz)) return 'MX';
    return '';
  }

  // Gregorian Easter (anonymous algorithm), month 1-12.
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day);
  }

  // Returns { id, gray } for the given local date and region, or null.
  function eventFor(date, reg) {
    const m = date.getMonth() + 1, d = date.getDate(), md = m * 100 + d;
    if (reg === 'TR' && md === 1110) return { id: 'tr-1110', gray: true };
    if (md === 1231 || md === 101) return { id: 'newyear' };
    if (md === 1030 || md === 1031) return { id: 'halloween' };
    if (reg === 'TR' && (md === 423 || md === 519 || md === 830 || md === 1029)) return { id: 'tr-national' };
    if (reg === 'JP' && md === 505) return { id: 'jp-kodomo' };
    if (reg === 'US' && md === 704) return { id: 'us-july4' };
    if (reg === 'BR' && md === 907) return { id: 'br-independence' };
    if (reg === 'MX' && md === 916) return { id: 'mx-independence' };
    if (reg === 'BR') {
      const tue = easter(date.getFullYear()); tue.setDate(tue.getDate() - 47); // Carnival Tuesday
      const sat = new Date(tue); sat.setDate(tue.getDate() - 3);
      const t = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
      if (t >= sat.getTime() && t <= tue.getTime()) return { id: 'br-carnival' };
    }
    return null;
  }

  function today(opts) {
    opts = opts || {};
    return eventFor(opts.date || new Date(), region(opts.tz));
  }

  // ─── Images ───
  // Themed days use ready-made images in icons/special/<id>-<size>.png (drawn
  // as vectors and exported per size so they stay sharp in the toolbar).
  // 10 November is the normal logo turned black and white.
  const SIZES = [16, 32, 48, 128];
  const THEMED = ['halloween', 'newyear', 'tr-national', 'us-july4', 'br-independence', 'br-carnival', 'jp-kodomo', 'mx-independence'];
  const imgPath = (id, s) => `icons/special/${id}-${s}.png`;

  function grayInto(ctx, size, base) {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(base, 0, 0, size, size);
    const img = ctx.getImageData(0, 0, size, size), p = img.data;
    for (let i = 0; i < p.length; i += 4) {
      const y = Math.round(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]);
      p[i] = p[i + 1] = p[i + 2] = y;
    }
    ctx.putImageData(img, 0, 0);
  }
  async function loadBitmap(url) { return createImageBitmap(await (await fetch(url)).blob()); }

  // Background: argument for chrome.action.setIcon. getURL turns a relative
  // path into a full extension URL.
  async function iconDetails(ev, getURL) {
    if (ev && ev.gray) {
      const base = await loadBitmap(getURL('icons/icon128.png'));
      const imageData = {};
      for (const s of [16, 32, 48]) {
        const cv = new OffscreenCanvas(s, s), ctx = cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        grayInto(ctx, s, base);
        imageData[s] = ctx.getImageData(0, 0, s, s);
      }
      return { imageData };
    }
    if (ev && THEMED.includes(ev.id)) {
      const path = {};
      for (const s of [16, 32, 48]) path[s] = '/' + imgPath(ev.id, s);
      return { path };
    }
    return { path: { 48: '/icons/icon48.png', 128: '/icons/icon128.png' } };
  }

  // Extension pages: swap an <img> logo for the day's version.
  async function decorateImg(img, ev, getURL) {
    if (!img || !ev) return;
    try {
      if (ev.gray) {
        const base = await loadBitmap(getURL('icons/icon128.png'));
        const cv = document.createElement('canvas'); cv.width = cv.height = 128;
        grayInto(cv.getContext('2d'), 128, base);
        img.src = cv.toDataURL('image/png');
      } else if (THEMED.includes(ev.id)) {
        img.src = getURL(imgPath(ev.id, 128));
      } else return;
      img.dataset.specialDay = ev.id;
    } catch (e) {}
  }

  // The day's event, honouring the settings switch and the test panel preview
  // (_specialDayPreview = { id, until }). Works in the background and in pages.
  async function resolve() {
    const st = await chrome.storage.local.get(['specialDayIcons', '_specialDayPreview']);
    if (st.specialDayIcons === false) return null;
    const pv = st._specialDayPreview;
    if (pv && pv.id && pv.until > Date.now()) return { id: pv.id, gray: pv.id === 'tr-1110', preview: true };
    return today();
  }

  root.KASpecialDay = { region, eventFor, today, easter, resolve, iconDetails, decorateImg, ids: THEMED.concat('tr-1110'), SIZES };
})(typeof self !== 'undefined' ? self : this);
