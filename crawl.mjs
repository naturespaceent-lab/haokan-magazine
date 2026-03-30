#!/usr/bin/env node

/**
 * HAOKAN Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-pop news sites,
 * extracts article data, rewrites to Simplified Chinese,
 * and generates Xiaohongshu-inspired static HTML pages.
 *
 * Usage: node crawl.mjs
 * No dependencies needed — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/haokan-placeholder/800/450';

const log = (msg) => console.log(`[HAOKAN Crawler] ${msg}`);
const warn = (msg) => console.warn(`[HAOKAN Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting — Chinese style
// ============================================================

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = d.getMonth() + 1;
    const dd = d.getDate();
    return `${yyyy}年${mm}月${dd}日`;
  } catch {
    return '';
  }
}

// ============================================================
// REWRITE ENGINE — Xiaohongshu-style Chinese titles
// ============================================================

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Ros\u00e9', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier keyword map ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  drama:        ['drama', 'movie', 'film', 'acting', 'kdrama', 'k-drama', 'episode', 'season'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  mv:           ['mv', 'music video', 'teaser', 'm/v', 'visual', 'concept photo'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest'],
  sns:          ['sns', 'selfie', 'instagram', 'twitter', 'weibo', 'update', 'post', 'selca'],
  chart_perf:   ['music show', 'inkigayo', 'music bank', 'mcountdown', 'music core', 'win'],
};

// ---- Title templates per topic (Xiaohongshu style) ----

const TITLE_TEMPLATES = {
  comeback: [
    '天啊！{artist}回归也太绝了吧',
    '{artist}新专来了！这次的概念我真的爱了',
    '必看！{artist}回归全方位解析',
    '{artist}回归预告一出我直接尖叫',
    '等了好久的{artist}终于回归了！',
    '{artist}这次回归绝对是今年最强',
    '快看！{artist}回归造型太绝了',
    '{artist}新专概念曝光，风格大变太惊喜',
  ],
  chart: [
    '{artist}又破纪录了！数据逆天',
    '太强了！{artist}音源成绩全面开花',
    '{artist}打歌舞台+成绩汇总',
    '{artist}这数据我看了直呼离谱',
    '恭喜{artist}拿下一位！实至名归',
    '{artist}音源爆了！各平台成绩总结',
    '{artist}打破自身纪录，太厉害了',
  ],
  release: [
    '{artist}新歌循环一整天停不下来',
    '听完{artist}新专，我直接封神',
    '{artist}新曲测评：这次真的不一样',
    '{artist}新专全曲赏析，每首都是宝藏',
    '强推！{artist}新歌质量太高了',
    '{artist}新砖来了，先说结论：绝了',
    '单曲循环{artist}的新歌根本停不下来',
  ],
  concert: [
    '去了{artist}演唱会，现场太震撼了',
    '{artist}巡演攻略+现场repo来了',
    '我在{artist}演唱会现场哭了',
    '{artist}演唱会安利！错过等于白活',
    '{artist}巡演现场直拍太好哭了',
    '最全{artist}演唱会攻略帖',
    '{artist}live实力太能打了！',
  ],
  fashion: [
    '{artist}今天的穿搭也太好看了吧',
    '跟着{artist}学穿搭，时尚感拉满',
    '{artist}机场私服合集，每套都想抄',
    '{artist}穿搭分析：原来时尚这么简单',
    '被{artist}的穿搭品味惊艳到了',
    '{artist}今日look太绝了不接受反驳',
    '{artist}时尚穿搭合集持续更新中',
  ],
  drama: [
    '{artist}新剧太好看了停不下来',
    '安利{artist}最新韩剧，剧情神了',
    '{artist}的演技进步太大了吧',
    '{artist}新剧名场面合集，太上头了',
    '追{artist}新剧的第N天，还是好好看',
    '强推{artist}主演的这部剧！',
  ],
  award: [
    '恭喜{artist}拿下大奖！实至名归',
    '{artist}获奖感言太感人了',
    '{artist}红毯造型绝美合集',
    '颁奖典礼上的{artist}太闪了',
    '{artist}拿奖那刻我激动哭了',
    '{artist}获奖合集，实力说明一切',
  ],
  mv: [
    '{artist}新MV太好看了反复看了十遍',
    '{artist}MV彩蛋解析！你发现了几个',
    '被{artist}新MV的质感震撼到了',
    '{artist}新MV画面太美了全是大片感',
    '逐帧分析{artist}最新MV的隐藏细节',
  ],
  debut: [
    '新人{artist}出道舞台太惊艳了',
    '安利一个宝藏新团{artist}',
    '{artist}出道就是天花板',
    '这个新团{artist}太能打了吧',
    '{artist}出道曲质量太高了必须安利',
    '新人王预定！{artist}出道即巅峰',
  ],
  collab: [
    '{artist}联名款必须冲！限量发售中',
    '{artist}X品牌联动太惊喜了',
    '{artist}合作舞台简直神仙打架',
    '{artist}的联名也太好看了吧',
    '快冲！{artist}联名限量款来了',
  ],
  variety: [
    '{artist}综艺名场面，笑到停不下来',
    '安利{artist}最新综艺，太可爱了',
    '{artist}的综艺感也太好了吧',
    '看{artist}综艺笑出腹肌的一天',
    '{artist}综艺高光时刻合集',
    '{artist}上综艺了！笑点太密集',
  ],
  sns: [
    '{artist}更新了！这组自拍也太绝了',
    '天哪{artist}的ins更新了快来看',
    '{artist}社交媒体高光时刻合集',
    '{artist}最新自拍合集太可了',
    '快看{artist}更新了！颜值暴击',
  ],
  chart_perf: [
    '{artist}打歌舞台太炸了',
    '{artist}一位安可舞台！感动',
    '看了{artist}打歌直拍直接入坑',
  ],
  general: [
    '今天的韩娱大事件你知道了吗',
    'K-POP圈最新消息速递',
    '这条新闻韩饭必须知道',
    '韩娱圈今日热点汇总',
    'K-POP最新动态一分钟速看',
    '追星女孩必看！今日韩娱速报',
    '韩流资讯速递：今天有什么大新闻',
    '今日份的韩娱大瓜来了',
  ],
};

const NO_ARTIST_TEMPLATES = [
  'K-POP圈今日最大的新闻来了',
  '韩娱圈又出大事了！速看',
  '追星女孩必看的今日资讯',
  '韩流圈的最新动态你跟上了吗',
  '今天的K-POP新闻太精彩了',
  'K-POP圈又有好消息了',
  '这条韩娱新闻不看就亏了',
  '今日份韩娱资讯已送达',
  '追星人必知的最新消息',
  'K-POP今日热点速递来了',
  '韩娱圈最新消息全面汇总',
  '快来看今天的K-POP大事件',
];

// ---- Display categories in Chinese ----

const DISPLAY_CATEGORIES = {
  comeback: '推荐',
  chart: '打榜',
  release: '新歌',
  concert: '现场',
  fashion: '时尚',
  drama: '影视',
  award: '获奖',
  mv: '新歌',
  debut: '出道',
  collab: '联名',
  variety: '综艺',
  sns: '社交',
  chart_perf: '打榜',
  general: '资讯',
};

// ---- Helper: pick random item from array ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---- Step 1: Extract artist name from title ----

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', "don't", "doesn't", "didn't", "won't", "can't",
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) {
      return name;
    }
  }

  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) {
        return name;
      }
    }
  }

  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) {
      return candidate;
    }
  }

  return null;
}

// ---- Step 2: Classify topic ----

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return topic;
      }
    }
  }
  return 'general';
}

// ---- Step 3 & 4: Generate Chinese title ----

// Track used titles globally to avoid duplicates
const _usedRewrittenTitles = new Set();

function rewriteTitle(originalTitle, source) {
  // If already Chinese, keep as-is
  if (/[\u4E00-\u9FFF]/.test(originalTitle)) {
    if (!_usedRewrittenTitles.has(originalTitle)) {
      _usedRewrittenTitles.add(originalTitle);
      return originalTitle;
    }
  }

  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const shuffled = [...templates].sort(() => Math.random() - 0.5);
    for (const template of shuffled) {
      const candidate = template.replace(/\{artist\}/g, artist);
      if (!_usedRewrittenTitles.has(candidate)) {
        _usedRewrittenTitles.add(candidate);
        return candidate;
      }
    }
    // All templates for this artist+topic used — differentiate
    const fallback = shuffled[0].replace(/\{artist\}/g, artist);
    const unique = `${fallback}（${originalTitle.slice(0, 20)}）`;
    _usedRewrittenTitles.add(unique);
    return unique;
  }

  // No artist — pick from NO_ARTIST_TEMPLATES ensuring uniqueness
  const shuffled = [...NO_ARTIST_TEMPLATES].sort(() => Math.random() - 0.5);
  for (const t of shuffled) {
    if (!_usedRewrittenTitles.has(t)) {
      _usedRewrittenTitles.add(t);
      return t;
    }
  }
  // All exhausted — append counter
  const counter = _usedRewrittenTitles.size;
  const fallback = `${shuffled[0]}（第${counter}期）`;
  _usedRewrittenTitles.add(fallback);
  return fallback;
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Category mapping
// ============================================================

function displayCategory(category) {
  const topic = classifyTopic(category || '');
  return DISPLAY_CATEGORIES[topic] || '资讯';
}

function displayCategoryFromTopic(topic) {
  return DISPLAY_CATEGORIES[topic] || '资讯';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) {
      image = extractImageFromContent(contentEncoded);
    }
    if (!image) {
      image = extractImageFromContent(description);
    }

    if (!title || !link) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) {
    bodyHtml = cleaned;
  }

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    const content = extractArticleContent(html);
    return content;
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body rewriting — Chinese, Xiaohongshu tone
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      '姐妹们！{artist}终于要回归了！关于这次回归的信息一出来，整个K-POP圈都炸了。据说这次的概念和之前完全不一样，光看预告就已经超级期待了。',
      '{artist}回归的消息终于官宣了，等这一天等了太久了吧！官方透露这次回归在音乐风格上会有很大的突破，作为粉丝真的太激动了。',
      '终于等到了！{artist}的回归消息公布后，粉丝们的期待值直接拉满。这次据说准备了很长时间，音乐质量绝对有保障。',
    ],
    analysis: [
      '据业内人士透露，{artist}为了这次回归准备了相当长的时间，在歌曲创作上也有深度参与。从目前放出的预告内容来看，这次的作品完成度非常高，粉丝社区里各种分析帖子已经讨论得热火朝天了。',
      '这次{artist}的回归从音乐到视觉都会有很大的变化。社交媒体上预告刚放出来就冲上了热搜，反响真的太炸了。结合目前K-POP市场的趋势来看，这次回归的意义非常大。',
      '{artist}这次回归可以说是最近K-POP圈最值得关注的大事之一。在前作取得巨大成功的基础上，这次明显要挑战更高的目标。连音乐评论家们都在密切关注{artist}接下来的动作。',
    ],
    closing: [
      'HAOKAN编辑部会持续跟踪{artist}回归的最新消息，第一时间给大家带来更多详情。接下来的进展一定不要错过！',
      '{artist}的回归会给K-POP圈带来怎样的影响呢？HAOKAN编辑部会持续关注，有新消息随时更新给大家。',
    ],
  },
  release: {
    opening: [
      '姐妹们快来！{artist}的新专终于发了！听完只想说一个字：绝！这张专辑在音乐方向上做了新的尝试，能明显感受到{artist}的成长和进步。',
      '等了好久的{artist}新作终于揭开神秘面纱了！从歌单和制作团队的阵容来看，{artist}这次是真的全力以赴了。',
      '{artist}带着全新作品回来了。和前作不同的制作思路，让这张专辑充满了{artist}作为艺术家进化的痕迹，质感太好了。',
    ],
    analysis: [
      '这张专辑最大的亮点在于{artist}深度参与了歌曲创作。据说歌词和旋律都融入了{artist}现阶段的真实想法和感受，和制作人的碰撞效果也非常好，完成度相当高。',
      '一首一首听下来，真的被{artist}在音乐上的广度惊到了。主打歌够抓耳，收录曲也首首能打。整张专辑风格统一但又不单调，听感真的太好了。',
      '音乐评论家们对这张专辑的评价也很高。在保持{artist}个人特色的同时融入了新的音乐元素，这种平衡做得恰到好处。发行后的榜单成绩也值得期待。',
    ],
    closing: [
      '关于{artist}新专的更多信息和反馈，HAOKAN编辑部会持续跟进。这张专辑会给乐坛带来怎样的影响，让我们拭目以待。',
      '接下来的打歌活动和音乐节目舞台也很令人期待。HAOKAN编辑部会随时为大家带来{artist}的最新消息。',
    ],
  },
  concert: {
    opening: [
      '去了{artist}的演唱会，只能说现场的氛围真的太震撼了！那种舞台上的感染力和与粉丝之间的互动，只有到了现场才能真正体会到。',
      '{artist}站上舞台的那一刻，整个会场都沸腾了。从歌单到舞台设计的每一个细节，都能感受到{artist}的用心和执着。',
      '{artist}演唱会的信息一公布，粉丝群里瞬间就炸了。这次公演对{artist}来说，绝对是职业生涯中非常重要的一笔。',
    ],
    analysis: [
      '这次演唱会的歌单从经典曲目到最新歌曲全覆盖，完全满足了粉丝们的期待。最值得一提的是舞台效果，运用了最新技术的舞美设计真的让人叹为观止。和粉丝的互动环节也特别暖心。',
      '{artist}的现场实力真的不是盖的，比录音室版本还要炸。唱功、舞蹈、表现力全方位在线，专业实力展现得淋漓尽致。现场那种一体感，就是{artist}和粉丝之间深厚羁绊的最好证明。',
      '据工作人员透露，{artist}从彩排阶段就对每一个细节都极其认真。这种态度直接反映在了正式演出的质量上。社交媒体上演出结束后粉丝们的感动repo到处都是。',
    ],
    closing: [
      '关于{artist}后续的演出日程，HAOKAN编辑部会第一时间给大家带来消息。下一场演出也绝对不能错过！',
      '演唱会的余温还没散去，粉丝们已经开始期待{artist}的下一场舞台了。HAOKAN编辑部会持续带来追踪报道。',
    ],
  },
  fashion: {
    opening: [
      '{artist}最新的穿搭又上热搜了！把握趋势的同时又不失个人风格，难怪时尚圈对ta评价那么高。',
      '作为时尚icon的{artist}又带来了新的穿搭灵感。{artist}的穿搭一上身，立刻就在社交媒体上被疯传，反响超级大。',
      '{artist}的时尚品味又一次成为焦点。从品牌合作到日常穿搭，{artist}在时尚领域的表现越来越亮眼了。',
    ],
    analysis: [
      '{artist}穿搭最大的特点就是高奢和街头的mix感拿捏得太好了。这次也不例外，那种恰到好处的平衡感真的绝了。时尚杂志的编辑们也都在关注{artist}的穿搭动态呢。',
      '时尚圈的专业人士分析说，{artist}的穿搭风格对年轻一代的时尚趋势有着巨大的影响力。ta穿过的单品咨询量和销量都会暴涨，这种"{artist}效应"对品牌方来说太有吸引力了。',
      '{artist}的穿搭和音乐活动中的世界观也是密切相关的。跟着概念变化的造型也是粉丝们很享受的部分。{artist}会传递怎样的时尚态度，让我们继续关注。',
    ],
    closing: [
      '关于{artist}时尚方面的最新资讯，HAOKAN编辑部会带着穿搭分析一起持续更新。接下来的造型也很令人期待。',
      '在时尚领域也在不断进化的{artist}，未来可期。HAOKAN编辑部会继续为大家带来穿搭趋势分析。',
    ],
  },
  award: {
    opening: [
      '{artist}拿奖了！听到获奖消息的那一刻，粉丝们都沸腾了。这次获奖不仅是对{artist}实力的认可，更是一直以来努力的最好回报。',
      '颁奖那一刻{artist}脸上的表情真的太让人感动了。经过长期努力终于拿到的荣誉，对{artist}来说意义重大。',
      '{artist}获奖的消息一出来，粉丝和业内人士纷纷送上祝福。这个奖真的是实至名归。',
    ],
    analysis: [
      '这次{artist}能获奖，是音乐品质和商业成绩双重认可的结果。评委们特别赞赏了{artist}的独创性和革新精神。作为K-POP艺人能拿到这个奖，意义真的非常大。',
      '{artist}在获奖感言中表达了感恩之情，感谢了一直支持ta的粉丝和工作人员。那一刻很多粉丝都被感动到了，社交媒体上满满都是感动的评论。获奖后的媒体曝光量预计也会大幅增加。',
      '音乐评论家们谈到{artist}的获奖，都说是"意料之中"。回顾今年的表现，这个奖完全说得过去。这次获奖一定会给{artist}的事业带来更大的助力。',
    ],
    closing: [
      '期待{artist}接下来更大的飞跃。HAOKAN编辑部会持续跟进获奖相关的后续消息，第一时间带给大家。',
      '获奖后站上新台阶的{artist}，接下来的表现更值得期待。HAOKAN编辑部会继续关注ta的最新动态。',
    ],
  },
  variety: {
    opening: [
      '{artist}上综艺了！平时在舞台上超级飒的ta，没想到综艺感这么强，看得我笑到停不下来。和舞台上完全不一样的反差萌，太可爱了。',
      '{artist}的综艺表现引发了超级大的话题。那个口才和临场反应，观众们都被圈粉了。',
      '{artist}在综艺上展现了不一样的魅力。除了音乐以外的才华，成功吸引了一大波新粉丝。',
    ],
    analysis: [
      '{artist}上综艺其实也是一种拓展艺人形象的有效方式。节目里自然不做作的反应和谈吐太圈粉了，"原来{artist}综艺感这么好"这种评论到处都是。出演后社交媒体的关注度也明显涨了。',
      '据节目制作方透露，{artist}在录制现场的表现给所有人都留下了超好的印象。不依赖剧本的自然反应，加上能活跃气氛的性格，不管是搭档嘉宾还是工作人员都给了很高的评价。',
    ],
    closing: [
      '关于{artist}的综艺出演消息，HAOKAN编辑部绝不会错过。综艺上的精彩表现也值得持续关注。',
      '多才多艺的{artist}，音乐以外的活动同样精彩。HAOKAN编辑部会持续带来最新资讯。',
    ],
  },
  sns: {
    opening: [
      '快看！{artist}又更新了！这组照片也太好看了吧，颜值真的太能打了。每次{artist}更新社交媒体，评论区都会瞬间被刷爆。',
      '{artist}在社交媒体上的更新又引发了一波热议。ta分享的日常太有生活气息了，粉丝们看得超满足。',
      '{artist}最新发的照片质量太高了，简直可以直接当杂志大片用。难怪每次更新都能上热搜。',
    ],
    analysis: [
      '{artist}在社交媒体上的互动频率一直很高，和粉丝之间的距离感特别近。每次更新的内容不管是自拍还是日常分享，都能引发大量的讨论和二创。这种互动方式也是{artist}能维持超高人气的重要原因。',
      '从数据上看，{artist}每次更新后的互动量都在稳步增长。点赞、评论、转发的数据都非常亮眼。{artist}在社交媒体上的影响力已经远远超出了K-POP圈，在整个娱乐领域都是顶级的存在。',
    ],
    closing: [
      '想第一时间看到{artist}的更新？记得关注HAOKAN，我们会随时为你推送最新的偶像动态。',
      '{artist}的每一次更新都值得期待。HAOKAN编辑部会持续为大家带来偶像社交媒体的精彩内容。',
    ],
  },
  debut: {
    opening: [
      '{artist}终于出道了！一亮相就惊艳了所有人。经过漫长的练习生时期，这个舞台对{artist}来说有着特别的意义。',
      '新生代艺人{artist}的出道消息一发布，业内外都投来了超高的关注度。出道前就被寄予厚望的{artist}，实力终于要正式展现了。',
      'K-POP圈又迎来了一颗新星。{artist}的出道，成为了最近最受瞩目的大事件之一。',
    ],
    analysis: [
      '从出道作品来看，{artist}的潜力真的太大了。歌曲质量和舞台表现力都不像是新人，对未来的成长空间非常期待。公司的培养实力和制作水准也值得称赞。',
      '音乐评论家们对{artist}的出道一致给出了"年度最值得关注新人"的评价。出道曲的完成度很高，已经初步建立了独特的风格。粉丝基础也在飞速扩大中。',
    ],
    closing: [
      '新人出道就展现了超强存在感的{artist}。HAOKAN编辑部会持续追踪ta出道后的每一步成长。',
      '{artist}的出道对K-POP圈来说也是一件大事。HAOKAN编辑部会继续关注ta未来的发展。',
    ],
  },
  collab: {
    opening: [
      '{artist}的联名合作终于来了！粉丝们等这一刻等了太久了吧。两方的碰撞会产生怎样的化学反应，真的太值得期待了。',
      '梦幻联动！{artist}参与的这次合作，对双方的粉丝来说都是期待已久的企划，激动程度直接拉满。',
      '{artist}新的合作项目公布了，在音乐圈引发了超大的话题。不同风格的融合会带来怎样的作品，所有人都在翘首以盼。',
    ],
    analysis: [
      '从合作作品来看，在保留{artist}个人特色的同时又加入了新鲜的元素。互相的艺术优势产生了很好的化学效果，和单人作品相比又是不一样的魅力。',
      '这次合作最突出的就是音乐上的默契配合。不管是对{artist}的粉丝还是合作方的粉丝来说，都能发现全新的一面。这种跨界合作可以说是非常成功的案例了。',
    ],
    closing: [
      '通过合作开拓了新领域的{artist}。HAOKAN编辑部会继续跟进合作作品的后续消息。',
      '{artist}的新挑战值得所有人关注。HAOKAN编辑部会持续带来相关的最新资讯。',
    ],
  },
  general: {
    opening: [
      '关于{artist}的最新消息来了！HAOKAN编辑部从K-POP最前线为大家带来最值得关注的资讯。',
      '{artist}的最新动态曝光了。在多个领域都在活跃的{artist}，这次又有什么新动作呢。',
      '{artist}又上热搜了，HAOKAN编辑部用独家视角为你解读详情。',
      'HAOKAN编辑部精选推送：关于{artist}最新的娱乐资讯，这次的话题热度很高。',
    ],
    analysis: [
      '{artist}的活动涉及面非常广，不仅仅局限于音乐领域。这次的事情也是{artist}多元化发展中值得关注的一部分。粉丝间的讨论非常热烈，社交媒体上的反应也很积极。',
      '据业内人士透露，{artist}一直在积极寻求新的突破。这次的话题也是{artist}在成长和进化过程中自然产生的。后续的发展也很值得期待。',
      '这条消息对{artist}的粉丝来说是个好消息。一直在关注{artist}动态的HAOKAN编辑部，也非常期待后续的发展。对整个K-POP圈来说也有着重要的意义。',
    ],
    closing: [
      'HAOKAN编辑部会持续为大家带来{artist}的最新资讯。后续的发展也请继续关注。',
      '关于{artist}的新消息，HAOKAN会随时更新。最新的K-POP资讯，就在HAOKAN。',
      'HAOKAN编辑部会继续从最前线为你带来{artist}的动态。持续关注不迷路。',
    ],
  },
};

// Generic (no artist) body templates
const NO_ARTIST_BODY = {
  opening: [
    'K-POP圈又有新动态了！HAOKAN编辑部为大家带来最值得关注的最新消息。',
    '娱乐圈的最新消息来了，这次的话题热度特别高，一起来看看吧。',
    '今天K-POP圈发生了一件大事，HAOKAN编辑部用独家视角为你深度解析。',
    '最近韩娱圈最热的话题来了，HAOKAN编辑部第一时间为你整理。',
  ],
  analysis: [
    '这次的话题不仅在K-POP粉丝圈引发了关注，在整个娱乐圈都是值得关注的动向。社交媒体上各种讨论非常活跃，各种分析也层出不穷。后续发展也可能会引发更大的话题。',
    '针对这件事，业内人士给出了各种不同的解读。在K-POP市场快速变化的当下，这类动向对于判断未来趋势也有着重要的参考价值。HAOKAN编辑部也会持续保持关注。',
    '深入了解后会发现，这个话题的背后其实反映了K-POP圈的一些结构性变化。全球市场的扩大和粉丝文化的进化，催生了这类新闻的土壤。',
  ],
  closing: [
    'HAOKAN编辑部会持续为大家带来最新的K-POP资讯。后续的发展也请继续关注。',
    '更多精彩的韩娱资讯，就在HAOKAN。我们会第一时间为你推送最新消息。',
    '接下来还会有更多值得关注的消息。HAOKAN编辑部精选的内容，一定不要错过。',
  ],
};

// Shared expansion paragraphs — Xiaohongshu-style casual Chinese
const SHARED_PARAGRAPHS = {
  background: [
    '{artist}出道以来，一直在稳步扩大自己的粉丝群体。在不断拓展音乐风格的同时又保持了独特的辨识度，这种能力让很多听众都成为了忠实粉丝。特别是最近在海外市场的知名度也在快速提升。',
    '回顾{artist}的发展轨迹，可以说是充满了挑战与成长。从出道开始就设定了很高的目标，并且一步一步都在实现，这种态度就是ta们能走到今天这个位置的原动力。',
    '在K-POP圈里，{artist}的定位是非常独特的。建立了和其他艺人完全不同的音乐身份，这也是{artist}最大的武器。业内人士对{artist}的发展方向评价也很高。',
    '在全球K-POP市场中，{artist}的存在感一年比一年强。从各国的音乐榜单和社交媒体的反馈来看，{artist}的影响力已经在全球范围内不断扩大。特别是在亚洲地区的人气真的太火了。',
    '{artist}一路走来，一直在不断挑战自我的极限。不管是音乐、舞台表演还是视觉呈现，都设定了很高的标准并且持续在超越。这种态度就是粉丝们如此热爱ta们的原因之一。',
    '从数据上看，{artist}的音乐流媒体播放量比去年有了非常大的增长。社交媒体的粉丝数也在持续上涨，数字化运营能力的提升对{artist}整体的活动都产生了积极的影响。',
  ],
  detail: [
    '综合各方面的信息来看，{artist}在这件事上做了非常充分的准备。对细节的执着态度直接反映在了最终成果的质量上。合作伙伴和工作人员都对{artist}的专业精神赞不绝口。',
    '社交媒体上关于{artist}的讨论量急剧增加，粉丝间的高关注度在数据上也有明确的体现。{artist}的名字在X上多次冲上趋势榜，相关话题标签也在全球范围内登上了热门。这种反响力度，就是{artist}影响力的最好证明。',
    '{artist}这次的动作和当下K-POP的整体趋势也有着密切的关联。在全球市场扩大、数字优先策略普及、粉丝互动方式进化的大背景下，{artist}一直走在最前沿。',
    '粉丝社区的分析显示，{artist}的内容每次发布都会引发越来越大的话题，这次也不例外。粉丝自发制作的反应视频和二创作品大量涌现，形成了二次传播效应。这种自发的推广力就是{artist}独有的优势。',
    '音乐评论家们对{artist}的音乐方向有着各种各样的解读。{artist}作品的共同特点就是抓耳和深度并存——第一次听就能被吸引，反复听还能发现新的东西，这种双重魅力让ta们获得了广泛的支持。',
    '{artist}这次的活动和所属公司的策略也有着密切的关系。周密的日程管理和推广策略，把{artist}的潜力发挥到了最大。团队协作的高水准直接体现在了产出的品质上。',
  ],
  reaction: [
    '粉丝们对这件事的反应铺天盖地。"等了太久了""超出期待"这类积极评价占了绝大多数，{artist}获得的支持力度再一次得到了确认。有些粉丝甚至感动得直接哭了。',
    '综合社交媒体上粉丝的声音来看，"只有{artist}才能做到"这种评价特别多。不管是老粉还是新粉，都在称赞{artist}的高品质，整个粉丝圈团结一致支持{artist}的场面真的很暖心。',
    '{artist}这次的动作也获得了其他K-POP粉丝圈的好评。跨越了不同的饭圈，大家一致认可{artist}的实力，这再次凸显了{artist}在整个K-POP圈中的地位。',
    '中国的粉丝社区反应特别热烈。各个社交平台上的粉丝站都在积极分享信息和安利，对{artist}的爱和期待满满都是。大家也在热切期盼{artist}能来中国。',
    '海外粉丝的反应同样火热。来自英语圈、东南亚、中南美等世界各地的粉丝都在社交媒体上表达对{artist}的支持，全球粉丝群体的凝聚力依然非常强。各国的粉丝站和社区也都在大规模报道这次的消息。',
  ],
  impact: [
    '{artist}这次的动作预计也会对整个K-POP行业产生一定的影响。{artist}展示的新方向，对后来的艺人来说也是非常有参考价值的范本。作为引领行业趋势的存在，{artist}的角色未来会越来越重要。',
    '娱乐行业的分析师们也在密切关注{artist}这次事件对市场的影响。在K-POP内容消费模式不断变化的当下，{artist}的做法有可能成为未来行业的新标准。',
    '从文化角度来看，{artist}的活动在韩国文化的全球传播方面也有着重要的意义。通过K-POP让全世界的人接触到韩国文化、增进相互理解，这正是娱乐产业所拥有的力量的象征。',
    '{artist}这次的项目被评价为进一步拓展了K-POP的可能性边界。不受既有框架限制的{artist}的创造力，对整个音乐产业来说也是非常有启发性的案例。这种创新性的尝试，正在支撑着行业的持续增长。',
  ],
  noArtist: {
    background: [
      'K-POP近年来经历了飞速的全球化发展。韩国的娱乐内容不仅在音乐领域，在剧集、电影、时尚等多个方面都展现出了世界级的影响力。在这个大背景下，这次的消息就显得特别值得关注。',
      '娱乐行业的格局随着数字技术的进步正在发生巨大的变化。社交媒体的普及拉近了艺人和粉丝之间的距离，内容消费的方式也变得越来越多样化。在这种变化中产生的这次动向，正好反映了行业的最新趋势。',
      'K-POP能在世界音乐市场占据一席之地，背后是漫长的探索和积累。如今韩国的娱乐产业已经发展成为年产值数十亿美元的市场，作为文化输出的支柱在国际上获得了广泛的认可。',
    ],
    detail: [
      '深入了解这个话题后会发现，K-POP生态系统的复杂性由此可见一斑。艺人、制作人、经纪公司、粉丝社区有机地联动，建立了将内容价值最大化的体系。这次的事件也正是其中的一个缩影。',
      '从数据来看，K-POP内容的全球消费量在过去几年中有了飞跃式的增长。流媒体播放量、社交媒体互动率、演唱会上座率等各项指标都呈上升趋势。',
      '这一动向的背后是粉丝文化的进化。现代的K-POP粉丝不仅仅是消费者，更承担着内容共创者的角色。粉丝自发进行翻译、宣传、数据分析，为艺人的知名度扩大做出贡献的生态系统，是K-POP所独有的。',
    ],
    reaction: [
      '网络上对这个话题的反应非常活跃。K-POP粉丝社区里各种角度的分析和讨论交织在一起。特别值得一提的是，粉丝之间的讨论大多是建设性的。',
      '中国的K-POP粉丝对这件事也表现出了很高的关注度。实时追踪韩国娱乐资讯的粉丝们来说，这次的消息是绝对不能错过的话题。社交媒体上的信息分享和讨论正在热烈进行中。',
    ],
    impact: [
      '从整个娱乐行业的角度来看，这次的事件是一个预示着行业未来发展方向的重要事件。K-POP对世界音乐圈的影响力正在逐年增大，这个趋势预计今后还会继续。',
      '从文化产业发展的角度来看，这次的消息也具有深远的意义。娱乐跨越国界连接人们的力量，在当今社会正变得越来越重要。K-POP正是站在这一最前沿的音乐类型。',
    ],
  }
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  const inlineImages = (articleContent?.images || []).slice(1, 4);

  const paragraphs = [];
  const usedTexts = new Set();
  const pickUnique = (arr) => {
    const available = arr.filter(t => !usedTexts.has(t));
    if (available.length === 0) return arr[Math.floor(Math.random() * arr.length)];
    const picked = available[Math.floor(Math.random() * available.length)];
    usedTexts.add(picked);
    return picked;
  };
  const shuffleAndPickUnique = (arr, n) => {
    const available = arr.filter(t => !usedTexts.has(t));
    const shuffled = [...available].sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, Math.min(n, shuffled.length));
    for (const p of picked) usedTexts.add(p);
    return picked;
  };

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickUnique(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPickUnique(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickUnique(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickUnique(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickUnique(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPickUnique(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPickUnique(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickUnique(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickUnique(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// Backdate articles — Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22 2026
  const range = endDate.getTime() - startDate.getTime();

  for (let i = 0; i < articles.length; i++) {
    // Distribute evenly, newest first
    const fraction = i / Math.max(articles.length - 1, 1);
    const ts = endDate.getTime() - fraction * range;
    const d = new Date(ts);
    // Add some randomness (hours)
    d.setHours(Math.floor(Math.random() * 14) + 8);
    d.setMinutes(Math.floor(Math.random() * 60));
    articles[i].pubDate = d;
    articles[i].formattedDate = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// Build image tag helper
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}" style="border-radius:0">`;
}

function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  if (src.startsWith('images/')) {
    src = '../' + src;
  }
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Section generators — Xiaohongshu style
// ============================================================

function generateMasonryCard(article) {
  if (!article) return '';
  // Random aspect ratio: ~60% chance of portrait (3/4), ~40% landscape (4/3)
  const isPortrait = Math.random() > 0.4;
  const aspectStyle = isPortrait ? 'aspect-ratio:3/4' : 'aspect-ratio:4/3';
  const likeCount = Math.floor(Math.random() * 900) + 100;
  const avatarId = Math.floor(Math.random() * 70) + 1;
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategoryFromTopic(topic);

  return `<a href="${escapeHtml(article.localUrl)}" class="masonry-card">
          <div class="card-img">
            <img src="${escapeHtml(article.image || PLACEHOLDER_IMAGE)}" alt="${escapeHtml(article.title)}" style="${aspectStyle}" loading="lazy" referrerpolicy="no-referrer" data-fallback="https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 15))}/400/500" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
          </div>
          <div class="card-body">
            <div class="card-title">${escapeHtml(article.title)}</div>
            <div class="card-footer">
              <div class="card-user">
                <img src="https://i.pravatar.cc/40?img=${avatarId}" alt="" width="20" height="20">
                <span>${escapeHtml(article.source)}</span>
              </div>
              <div class="card-like">
                <iconify-icon icon="solar:heart-bold"></iconify-icon>
                ${likeCount}
              </div>
            </div>
          </div>
        </a>`;
}

function generateTrendingItem(article, rank) {
  if (!article) return '';
  const rankClass = rank <= 3 ? 'trending-rank top3' : 'trending-rank';
  const fireIcon = rank <= 3 ? '<iconify-icon icon="solar:fire-bold" class="trending-fire"></iconify-icon>' : '';

  return `<a href="${escapeHtml(article.localUrl)}" class="trending-item">
          <span class="${rankClass}">${rank}</span>
          <div class="trending-thumb">
            <img src="${escapeHtml(article.image || PLACEHOLDER_IMAGE)}" alt="${escapeHtml(article.title)}" width="56" height="56" loading="lazy" referrerpolicy="no-referrer" data-fallback="https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 12))}/112/112" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
          </div>
          <div class="trending-text">
            <h3>${escapeHtml(article.title)}</h3>
            <div class="meta">${escapeHtml(article.formattedDate)} | ${escapeHtml(article.source)}</div>
          </div>
          ${fireIcon}
        </a>`;
}

function generateCollectionCard(article) {
  if (!article) return '';
  const topic = classifyTopic(article.originalTitle || article.title);
  const cat = displayCategoryFromTopic(topic);
  const likeCount = Math.floor(Math.random() * 500) + 50;

  return `<a href="${escapeHtml(article.localUrl)}" class="collection-card">
          <div class="coll-img">
            <img src="${escapeHtml(article.image || PLACEHOLDER_IMAGE)}" alt="${escapeHtml(article.title)}" loading="lazy" referrerpolicy="no-referrer" data-fallback="https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 12))}/400/300" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            <span class="coll-tag">${escapeHtml(cat)}</span>
          </div>
          <div class="coll-body">
            <h3>${escapeHtml(article.title)}</h3>
            <div class="coll-meta">
              <iconify-icon icon="solar:heart-bold" style="color:#ff2e4d;font-size:12px;vertical-align:-1px"></iconify-icon>
              ${likeCount}
            </div>
          </div>
        </a>`;
}

// ============================================================
// Generate hot topic pills
// ============================================================

function generateHotTopics(articles) {
  const topicSet = new Set();
  const pills = [];
  const topicLabels = [
    '回归', '新歌推荐', '穿搭灵感', '演唱会现场', '颁奖红毯',
    '综艺名场面', '偶像日常', '联名限定', '出道舞台', '打歌成绩',
    '自拍合集', 'K-POP', '追星日常', '宝藏新团', '应援教程',
  ];

  // Extract KNOWN artist names only (no raw English phrases)
  const knownNameSet = new Set(ALL_KNOWN_NAMES);
  for (const article of articles.slice(0, 50)) {
    const artist = extractArtist(article.originalTitle || article.title);
    // Only include if it's a recognized K-pop name, not a random English phrase
    if (artist && knownNameSet.has(artist) && !topicSet.has(artist)) {
      topicSet.add(artist);
      pills.push(`<span class="topic-pill"><iconify-icon icon="solar:hashtag-linear"></iconify-icon>${escapeHtml(artist)}</span>`);
      if (pills.length >= 6) break;
    }
  }

  // Fill remaining with Chinese generic topics
  for (const label of topicLabels) {
    if (pills.length >= 12) break;
    if (!topicSet.has(label)) {
      topicSet.add(label);
      pills.push(`<span class="topic-pill"><iconify-icon icon="solar:hashtag-linear"></iconify-icon>${escapeHtml(label)}</span>`);
    }
  }

  return pills.join('\n        ');
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  // Pre-assign localUrl to ALL usedArticles
  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    // Find related articles
    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    // Build article body
    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src.startsWith('http') ? item.src : item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/680/383`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="680" height="383" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    // Build hero image
    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) {
      heroImgSrc = '../' + heroImgSrc;
    }
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="680" height="383" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    // Build related articles
    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) {
        relImgSrc = '../' + relImgSrc;
      }
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/300`;
      const relTopic = classifyTopic(rel.originalTitle || rel.title);
      const relCat = displayCategoryFromTopic(relTopic);
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="300" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-body">
              <div class="related-category">${escapeHtml(relCat)}</div>
              <h3>${escapeHtml(rel.title)}</h3>
              <span class="date">${escapeHtml(rel.formattedDate)}</span>
            </div>
          </a>`;
    }

    // Build source attribution
    const sourceAttribution = `<div class="source-attribution">
          来源：<a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">查看原文 &rarr;</a>
        </div>`;

    // Build photo credit
    const photoCredit = `图片来源：&copy;${escapeHtml(article.source)}`;

    // Determine display category
    const topic = classifyTopic(article.originalTitle || article.title);
    const cat = displayCategoryFromTopic(topic);

    // Fill template
    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(cat))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 7;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/haokan-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const all = [...articles];

  const used = new Set();        // tracks by link (article identity)
  const usedTitles = new Set();  // tracks by title (deduplication)

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link) && !usedTitles.has(article.title)) {
        result.push(article);
        used.add(article.link);
        usedTitles.add(article.title);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 2 ? withRealImages : all;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const masonry = take(all, 8);
  const trending = take(all, 5);
  const collections = take(all, 4);

  return {
    hero: hero[0] || null,
    masonry,
    trending,
    collections,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections, articles) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  // Hero section
  if (sections.hero) {
    const h = sections.hero;
    const topic = classifyTopic(h.originalTitle || h.title);
    const cat = displayCategoryFromTopic(topic);
    template = template.replace('{{HERO_LINK}}', escapeHtml(h.localUrl));
    template = template.replace('{{HERO_IMAGE}}', imgTag(h, 1200, 500, 'eager'));
    template = template.replace('{{HERO_TITLE}}', escapeHtml(h.title));
    template = template.replace('{{HERO_CATEGORY}}', escapeHtml(cat));
    template = template.replace('{{HERO_DATE}}', escapeHtml(h.formattedDate));
    template = template.replace('{{HERO_SOURCE}}', escapeHtml(h.source));
  } else {
    template = template.replace('{{HERO_LINK}}', '#');
    template = template.replace('{{HERO_IMAGE}}', '');
    template = template.replace('{{HERO_TITLE}}', 'HAOKAN');
    template = template.replace('{{HERO_CATEGORY}}', '推荐');
    template = template.replace('{{HERO_DATE}}', '');
    template = template.replace('{{HERO_SOURCE}}', 'HAOKAN');
  }

  // Hot topics
  template = template.replace('{{HOT_TOPICS}}', generateHotTopics(articles));

  // Masonry feed
  template = template.replace(
    '{{MASONRY_FEED}}',
    sections.masonry.map(a => generateMasonryCard(a)).join('\n        ')
  );

  // Trending list
  template = template.replace(
    '{{TRENDING_LIST}}',
    sections.trending.map((a, i) => generateTrendingItem(a, i + 1)).join('\n        ')
  );

  // Collections
  template = template.replace(
    '{{COLLECTIONS}}',
    sections.collections.map(a => generateCollectionCard(a)).join('\n        ')
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting HAOKAN Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to Simplified Chinese (Xiaohongshu style)
  log('Rewriting titles to Chinese (Xiaohongshu style)...');
  let rewritten = 0;
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    article.title = rewriteTitle(original, article.source);
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles`);
  log('');

  // 4. Backdate articles (Jan 1 to Mar 22, 2026)
  log('Backdating articles to Jan 1 - Mar 22, 2026...');
  backdateArticles(articles);
  log('  Done');
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles for article page generation
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.masonry);
  addUsed(sections.trending);
  addUsed(sections.collections);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content for used articles
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML from template
  const html = await generateHtml(sections, articles);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.masonry.length +
    sections.trending.length +
    sections.collections.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[HAOKAN Crawler] Fatal error:', err);
  process.exit(1);
});
