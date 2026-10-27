// scripts/update-travels.mjs
// 每天由 GitHub Actions 執行：抓 YouTube「長影片」與 Instagram 的「貼文」「Reels」，
// 依你寫的標題／說明文字判斷地點，歸類到縣市，輸出 travels.json
// 需要的環境變數（存在 GitHub Secrets）：YT_API_KEY、IG_TOKEN
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHANNEL_ID = 'UCm5DmxNXdwovJmy_e1kxm3A';   // 你的 YouTube 頻道 ID
const { YT_API_KEY, IG_TOKEN } = process.env;
const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const PLACES = readJSON('places.json', {});         // 地點關鍵字 → 縣市（可自行編輯）
const OVERRIDES = readJSON('overrides.json', {});   // 個別修正：{ "貼文網址或影片ID": ["花蓮縣"] }（可不建立）

// ---------- 地點 → 縣市 ----------
// 1) 說明文字裡直接出現縣市名（台／臺皆可）
const COUNTY_RE = {
  '臺北市': /臺北/, '新北市': /新北/, '基隆市': /基隆/, '桃園市': /桃園/,
  '新竹縣': /新竹縣|新竹(?!市)/, '新竹市': /新竹市/, '苗栗縣': /苗栗/,
  '臺中市': /臺中/, '彰化縣': /彰化/, '南投縣': /南投/, '雲林縣': /雲林/,
  '嘉義縣': /嘉義縣|嘉義(?!市)/, '嘉義市': /嘉義市/, '臺南市': /臺南/, '高雄市': /高雄/, '屏東縣': /屏東/,
  '宜蘭縣': /宜蘭/, '花蓮縣': /花蓮/, '臺東縣': /臺東/, '澎湖縣': /澎湖/, '金門縣': /金門/, '連江縣': /連江|馬祖/
};
const norm = t => (t || '').replace(/台/g, '臺');
let TOWNS = {};   // 鄉鎮市區全名 → 縣市（只收全台唯一的名稱，例如「仁愛鄉」）
export function classify(text) {
  const t = norm(text), set = new Set();
  let place = '';
  for (const [c, re] of Object.entries(COUNTY_RE)) if (re.test(t)) set.add(c);                       // 縣市名
  for (const [p, cs] of Object.entries(PLACES)) if (!p.startsWith('_') && t.includes(p)) { cs.forEach(c => set.add(c)); place ||= p; }   // 景點／山名
  for (const [n, c] of Object.entries(TOWNS)) if (t.includes(n)) { set.add(c); place ||= n; }         // 鄉鎮名
  return { counties: [...set], place };
}
async function loadTowns() {   // 盡力而為：載入全台鄉鎮名稱，失敗就略過
  try {
    const r = await fetch('https://cdn.jsdelivr.net/npm/taiwan-atlas/towns-10t.json');
    const topo = await r.json();
    const count = {}, owner = {};
    for (const g of topo.objects.towns.geometries) {
      const n = norm(g.properties.TOWNNAME), c = norm(g.properties.COUNTYNAME);
      if (n && c) { count[n] = (count[n] || 0) + 1; owner[n] = c; }
    }
    for (const n in count) if (count[n] === 1 && n.length >= 3) TOWNS[n] = owner[n];
    console.log('已載入鄉鎮名稱：', Object.keys(TOWNS).length);
  } catch (e) { console.log('略過鄉鎮名稱判斷：', e.message); }
}

// ---------- YouTube（只收長影片） ----------
const isoSec = d => { const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };
async function isShort(id, sec) {
  if (sec > 180) return false;   // 超過 3 分鐘一定不是 Shorts
  try { const r = await fetch(`https://www.youtube.com/shorts/${id}`, { redirect: 'manual' }); return r.status === 200; }  // Shorts 網址會直接開啟，一般影片會被轉址
  catch { return sec <= 60; }
}
async function ytVideos() {
  if (!YT_API_KEY) { console.log('略過 YouTube（沒有 YT_API_KEY）'); return []; }
  const api = (path, q) => fetch(`https://www.googleapis.com/youtube/v3/${path}?${q}&key=${YT_API_KEY}`).then(async r => {
    if (!r.ok) throw new Error('YouTube API ' + r.status + ' ' + (await r.text()).slice(0, 300));
    return r.json();
  });
  const list = 'UU' + CHANNEL_ID.slice(2);          // 頻道的「上傳影片」播放清單
  const all = []; let token = '';
  for (let i = 0; i < 8; i++) {                      // 最多 400 支
    const j = await api('playlistItems', `part=snippet&maxResults=50&playlistId=${list}` + (token ? `&pageToken=${token}` : ''));
    for (const it of j.items || []) {
      const s = it.snippet;
      if (/^(Private|Deleted) video$/.test(s.title)) continue;
      all.push({ id: s.resourceId.videoId, title: s.title, text: s.title + '\n' + (s.description || ''), date: s.publishedAt });
    }
    token = j.nextPageToken; if (!token) break;
  }
  const dur = {};                                    // 查影片長度
  for (let i = 0; i < all.length; i += 50) {
    const j = await api('videos', `part=contentDetails&id=${all.slice(i, i + 50).map(v => v.id).join(',')}`);
    (j.items || []).forEach(v => { dur[v.id] = isoSec(v.contentDetails.duration); });
  }
  const out = []; let skipped = 0;
  for (const v of all) {
    const sec = dur[v.id] || 0;
    if (!sec || await isShort(v.id, sec)) { skipped++; continue; }   // 直播預告（長度 0）與 Shorts 都不收
    out.push({ type: 'video', ...v });
  }
  console.log(`YouTube：${out.length} 支長影片，略過 ${skipped} 支 Shorts／直播預告`);
  return out;
}

// ---------- Instagram（貼文與 Reels 分開） ----------
async function igPosts() {
  if (!IG_TOKEN) { console.log('略過 Instagram（沒有 IG_TOKEN）'); return []; }
  try { await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${IG_TOKEN}`); } catch {}   // 順便延長權杖效期
  fs.mkdirSync('ig', { recursive: true });
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  let url = `https://graph.instagram.com/me/media?fields=${fields}&limit=50&access_token=${IG_TOKEN}`;
  const out = [];
  for (let i = 0; i < 4 && url; i++) {               // 最多 200 則
    const r = await fetch(url);
    if (!r.ok) throw new Error('Instagram API ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    for (const m of j.data || []) {
      const cover = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;   // IG 圖片網址會過期，所以下載存進 ig/
      let img = '';
      if (cover) {
        const file = `ig/${m.id}.jpg`;
        if (!fs.existsSync(file)) { const ir = await fetch(cover); if (ir.ok) fs.writeFileSync(file, Buffer.from(await ir.arrayBuffer())); }
        if (fs.existsSync(file)) img = file;
      }
      const cap = m.caption || '';
      const title = (cap.split('\n').find(l => l.trim()) || 'Instagram').trim().slice(0, 40);
      const isReel = /\/reel\//.test(m.permalink || '');   // Reels 的網址是 /reel/，一般貼文是 /p/
      out.push({ type: isReel ? 'reel' : 'post', title, text: cap, url: m.permalink, img, date: m.timestamp });
    }
    url = j.paging?.next;
  }
  console.log(`Instagram：${out.filter(x => x.type === 'post').length} 則貼文、${out.filter(x => x.type === 'reel').length} 支 Reels`);
  return out;
}

// ---------- 主程式 ----------
async function main() {
  await loadTowns();
  const items = [...await ytVideos(), ...await igPosts()];   // 任一邊失敗會直接結束，不覆蓋舊的 travels.json
  const counties = {}, unmatched = [];
  for (const it of items) {
    const ov = OVERRIDES[it.url] || OVERRIDES[it.id];
    const found = ov ? { counties: ov, place: '' } : classify(it.text);
    const { text, ...rest } = it;
    if (!found.counties.length) { unmatched.push(rest); continue; }
    for (const c of found.counties) (counties[c] ||= []).push({ ...rest, place: found.place || c });
  }
  for (const c in counties) counties[c].sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync('travels.json', JSON.stringify({ updated: new Date().toISOString(), counties, unmatched }, null, 1));
  console.log(`完成：${items.length} 筆內容，${Object.keys(counties).length} 個縣市，${unmatched.length} 筆未分類`);
  unmatched.forEach(u => console.log('  未分類：', u.title, u.url || u.id));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
