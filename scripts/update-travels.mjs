// scripts/update-travels.mjs
// 每天由 GitHub Actions 執行：抓 YouTube 影片與 Instagram 貼文，依「地點文字」歸類到縣市，輸出 travels.json
// 需要的環境變數（存在 GitHub Secrets）：YT_API_KEY、IG_TOKEN
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CHANNEL_ID = 'UCm5DmxNXdwovJmy_e1kxm3A';   // 你的 YouTube 頻道 ID
const { YT_API_KEY, IG_TOKEN } = process.env;

// ---------- 地點 → 縣市 ----------
// 1) 說明文字裡直接出現縣市名（台／臺皆可）
const COUNTY_RE = {
  '臺北市': /臺北/, '新北市': /新北/, '基隆市': /基隆/, '桃園市': /桃園/,
  '新竹縣': /新竹縣|新竹(?!市)/, '新竹市': /新竹市/, '苗栗縣': /苗栗/,
  '臺中市': /臺中/, '彰化縣': /彰化/, '南投縣': /南投/, '雲林縣': /雲林/,
  '嘉義縣': /嘉義縣|嘉義(?!市)/, '嘉義市': /嘉義市/, '臺南市': /臺南/, '高雄市': /高雄/, '屏東縣': /屏東/,
  '宜蘭縣': /宜蘭/, '花蓮縣': /花蓮/, '臺東縣': /臺東/, '澎湖縣': /澎湖/, '金門縣': /金門/, '連江縣': /連江|馬祖/
};
// 2) 說明文字裡只寫景點／山名時，用這份對照表（可自行增減；一個地點可對應多個縣市）
export const PLACES = {
  '合歡': ['南投縣'], '武嶺': ['南投縣'], '清境': ['南投縣'], '日月潭': ['南投縣'], '能高': ['南投縣'],
  '奇萊': ['南投縣', '花蓮縣'], '玉山': ['南投縣'], '塔塔加': ['南投縣'],
  '阿里山': ['嘉義縣'], '奮起湖': ['嘉義縣'],
  '太魯閣': ['花蓮縣'], '七星潭': ['花蓮縣'],
  '梨山': ['臺中市'], '武陵': ['臺中市'], '雪山': ['臺中市'], '大雪山': ['臺中市'], '福壽山': ['臺中市'], '南湖大山': ['臺中市'],
  '太平山': ['宜蘭縣'], '龜山島': ['宜蘭縣'],
  '嘉明湖': ['臺東縣'], '向陽': ['臺東縣'],
  '北大武': ['屏東縣'], '墾丁': ['屏東縣'],
  '陽明山': ['臺北市'], '七星山': ['臺北市'],
  '九份': ['新北市'], '十分': ['新北市'], '觀音山': ['新北市'],
  '木馬古道': ['雲林縣'], '古坑': ['雲林縣']
};
const norm = t => (t || '').replace(/台/g, '臺');
export function classify(text) {
  const t = norm(text), set = new Set();
  let place = '';
  for (const [c, re] of Object.entries(COUNTY_RE)) if (re.test(t)) set.add(c);
  for (const [p, cs] of Object.entries(PLACES)) if (t.includes(p)) { cs.forEach(c => set.add(c)); place ||= p; }
  return { counties: [...set], place };
}

// ---------- YouTube ----------
async function ytVideos() {
  if (!YT_API_KEY) { console.log('略過 YouTube（沒有 YT_API_KEY）'); return []; }
  const list = 'UU' + CHANNEL_ID.slice(2);          // 頻道的「上傳影片」播放清單
  const out = []; let token = '';
  for (let i = 0; i < 8; i++) {                      // 最多 400 支
    const u = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${list}&key=${YT_API_KEY}` + (token ? `&pageToken=${token}` : '');
    const r = await fetch(u);
    if (!r.ok) throw new Error('YouTube API ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    for (const it of j.items || []) {
      const s = it.snippet;
      if (/^(Private|Deleted) video$/.test(s.title)) continue;
      out.push({ type: 'video', id: s.resourceId.videoId, title: s.title, text: s.title + '\n' + (s.description || ''), date: s.publishedAt });
    }
    token = j.nextPageToken; if (!token) break;
  }
  return out;
}

// ---------- Instagram ----------
async function igPosts() {
  if (!IG_TOKEN) { console.log('略過 Instagram（沒有 IG_TOKEN）'); return []; }
  // 順便延長權杖效期（失敗不影響抓取）
  try { await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${IG_TOKEN}`); } catch {}
  fs.mkdirSync('ig', { recursive: true });
  const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  let url = `https://graph.instagram.com/me/media?fields=${fields}&limit=50&access_token=${IG_TOKEN}`;
  const out = [];
  for (let i = 0; i < 4 && url; i++) {               // 最多 200 則
    const r = await fetch(url);
    if (!r.ok) throw new Error('Instagram API ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const j = await r.json();
    for (const m of j.data || []) {
      // IG 的圖片網址會過期，所以把封面圖下載存進 repo 的 ig/ 資料夾
      const cover = m.media_type === 'VIDEO' ? m.thumbnail_url : m.media_url;
      let img = '';
      if (cover) {
        const file = `ig/${m.id}.jpg`;
        if (!fs.existsSync(file)) {
          const ir = await fetch(cover);
          if (ir.ok) fs.writeFileSync(file, Buffer.from(await ir.arrayBuffer()));
        }
        if (fs.existsSync(file)) img = file;
      }
      const cap = m.caption || '';
      const title = (cap.split('\n').find(l => l.trim()) || 'Instagram 貼文').trim().slice(0, 40);
      out.push({ type: 'post', title, text: cap, url: m.permalink, img, date: m.timestamp });
    }
    url = j.paging?.next;
  }
  return out;
}

// ---------- 主程式 ----------
async function main() {
  const items = [...await ytVideos(), ...await igPosts()];   // 任一邊失敗會直接結束，不覆蓋舊的 travels.json
  const counties = {}, unmatched = [];
  for (const it of items) {
    const { counties: cs, place } = classify(it.text);
    const { text, ...rest } = it;
    if (!cs.length) { unmatched.push(rest); continue; }
    for (const c of cs) (counties[c] ||= []).push({ ...rest, place: place || c });
  }
  for (const c in counties) counties[c].sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync('travels.json', JSON.stringify({ updated: new Date().toISOString(), counties, unmatched }, null, 1));
  console.log(`完成：${items.length} 筆內容，${Object.keys(counties).length} 個縣市，${unmatched.length} 筆未分類`);
  unmatched.forEach(u => console.log('  未分類：', u.title, u.url || u.id));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exit(1); });
